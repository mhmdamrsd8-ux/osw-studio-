import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/generate-image/route';

function codexToken(accountId = 'acct-123'): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return `header.${payload}.signature`;
}

afterEach(() => vi.unstubAllGlobals());

describe('/api/generate-image Codex image generation', () => {
  it('uses the Responses image_generation tool and returns its PNG', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response([
      'event: response.output_item.done',
      'data: {"item":{"type":"image_generation_call","result":"png-base64"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = {
      json: async () => ({
        provider: 'openai-codex',
        apiKey: codexToken(),
        model: 'gpt-image-2-high',
        prompt: 'a lighthouse in a storm',
        image_config: { aspect_ratio: '16:9' },
      }),
    } as unknown as NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ image: 'data:image/png;base64,png-base64' });

    const [url, maybeInit] = fetchMock.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const init = maybeInit!;
    const headers = init.headers as Headers;
    expect(headers.get('chatgpt-account-id')).toBe('acct-123');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-5.5');
    expect(body.tools[0]).toMatchObject({
      type: 'image_generation',
      model: 'gpt-image-2',
      quality: 'high',
      size: '1536x1024',
    });
    expect(body.tool_choice).toEqual({
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'image_generation' }],
    });
  });
});

/**
 * A stalled upstream used to hang the tool call for good, which the agent showed as "stuck".
 * The route now carries a deadline and the caller's abort into every upstream fetch.
 */
function neverEndingBody(signal?: AbortSignal): Response {
  // A stream that emits one partial line and then never closes on its own. Like a real fetch, the
  // pending read rejects when the request's signal fires; that is what the route relies on.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"partial":true}\n'));
      signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

function requestFor(body: Record<string, unknown>, signal?: AbortSignal): NextRequest {
  return { json: async () => body, signal } as unknown as NextRequest;
}

describe('/api/generate-image gives up on a dead upstream', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('times out a Codex stream that never finishes', async () => {
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '50');
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => neverEndingBody(init?.signal ?? undefined));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(requestFor({ provider: 'openai-codex', apiKey: codexToken(), model: 'gpt-image-2-low', prompt: 'x' }));

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/timed out/) });
    // The deadline reached the upstream call, which is what makes a real stream end.
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('times out an OpenAI-compatible provider that never answers', async () => {
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '50');
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    })));

    const response = await POST(requestFor({ provider: 'openrouter', apiKey: 'sk', model: 'm', prompt: 'x' }));

    expect(response.status).toBe(504);
  });

  it('recognises a cancellation by the signal, whatever the runtime names the error', async () => {
    // undici rejects a client-side cancellation as `ResponseAborted`, which is neither AbortError
    // nor TimeoutError. Judging by name alone let a cancelled fetch fall through as a server error.
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '60000');
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('closed'), { name: 'ResponseAborted' })));
      setTimeout(() => controller.abort(), 10);
    })));

    const response = await POST(requestFor({ provider: 'openai-codex', apiKey: codexToken(), model: 'gpt-image-2-low', prompt: 'x' }, controller.signal));

    expect(response.status).toBe(499);
  });

  it('stops when the caller has already gone, without waiting for the deadline', async () => {
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '60000');
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      if (init?.signal?.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    })));

    const response = await POST(requestFor({ provider: 'openai-codex', apiKey: codexToken(), model: 'gpt-image-2-low', prompt: 'x' }, controller.signal));

    expect(response.status).toBe(499);
  });
});
