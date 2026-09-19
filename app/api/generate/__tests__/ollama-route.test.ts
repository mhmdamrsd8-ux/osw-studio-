import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * The route's Ollama wiring: the request goes to the native chat endpoint with the
 * context window Ollama should load, the reply comes back in the Chat Completions
 * shape the client parser reads, and an unreachable server is reported as such.
 *
 * `fetch` is a small fake Ollama: `/api/show` answers the context lookup and `/api/chat`
 * answers with captured NDJSON (streamed) or JSON (not).
 */

vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const TOOL_LINE = JSON.stringify({ model: 'qwen3:4b', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'bash', arguments: { command: 'ls' } } }] }, done: false });
const DONE_LINE = JSON.stringify({ model: 'qwen3:4b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 3 });

type Fake = { down?: boolean; context?: number };

function fakeOllama(fake: Fake = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (fake.down) throw new TypeError('fetch failed');
    const url = String(input);
    if (url.endsWith('/api/show')) {
      return new Response(JSON.stringify({ model_info: fake.context ? { 'qwen3.context_length': fake.context } : {} }), { status: 200 });
    }
    if (url.endsWith('/api/chat')) {
      const body = JSON.parse(String(init?.body));
      if (body.stream) return new Response(`${TOOL_LINE}\n${DONE_LINE}\n`, { status: 200 });
      return new Response(JSON.stringify({ model: 'qwen3:4b', message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 1 }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
}

function makeReq(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: new Headers(),
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

const base = {
  provider: 'ollama',
  model: 'qwen3:4b',
  messages: [{ role: 'user', content: 'list files' }],
  tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
};

async function post(body: unknown) {
  const { POST } = await import('../route');
  return POST(makeReq(body));
}

function chatCall(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/chat'))!;
  return { url: String(call[0]), body: JSON.parse(String((call[1] as RequestInit).body)) };
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/generate with Ollama', () => {
  it('sends the native chat request with the context window the model should load', async () => {
    const fetchMock = fakeOllama({ context: 262144 });
    vi.stubGlobal('fetch', fetchMock);

    await post(base);

    const { url, body } = chatCall(fetchMock);
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(body.options.num_ctx).toBe(32768);
    // The route adds its fallback system prompt ahead of a tool request with none.
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[body.messages.length - 1]).toEqual({ role: 'user', content: 'list files' });
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }]);
  });

  it('loads with the context length the request carries, capped at the model limit', async () => {
    const fetchMock = fakeOllama({ context: 262144 });
    vi.stubGlobal('fetch', fetchMock);

    await post({ ...base, context_length: 65536 });

    expect(chatCall(fetchMock).body.options.num_ctx).toBe(65536);
  });

  it('caps the context window at a smaller model limit', async () => {
    const fetchMock = fakeOllama({ context: 8192 });
    vi.stubGlobal('fetch', fetchMock);

    await post({ ...base, model: 'small:1b' });

    expect(chatCall(fetchMock).body.options.num_ctx).toBe(8192);
  });

  it('streams the reply back as Chat Completions SSE', async () => {
    vi.stubGlobal('fetch', fakeOllama());

    const res = await post(base);
    const text = await res.text();
    const chunks = text.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]')).map(l => JSON.parse(l.slice(6)));

    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(chunks[0].choices[0].delta.tool_calls[0]).toMatchObject({ id: 'call_1', function: { name: 'bash', arguments: '{"command":"ls"}' } });
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('returns a non-streamed reply as a chat completion', async () => {
    vi.stubGlobal('fetch', fakeOllama());

    const res = await post({ ...base, stream: false });
    const data = await res.json();

    expect(data.choices[0].message.content).toBe('ok');
    expect(data.usage).toEqual({ prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
  });

  it('reports an unreachable Ollama by its address, with the start command', async () => {
    vi.stubGlobal('fetch', fakeOllama({ down: true }));

    const res = await post(base);
    const data = await res.json();

    expect(res.status).toBe(503);
    expect(data.error).toContain('http://127.0.0.1:11434');
    expect(data.error).toContain('ollama serve');
  });

  it('keeps the generic network message for a cloud provider', async () => {
    vi.stubGlobal('fetch', fakeOllama({ down: true }));

    const res = await post({ ...base, provider: 'openrouter', apiKey: 'sk-x', model: 'x' });
    const data = await res.json();

    expect(res.status).toBe(503);
    expect(data.error).not.toContain('127.0.0.1');
  });
});
