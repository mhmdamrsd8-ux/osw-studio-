import { describe, it, expect } from 'vitest';
import {
  buildOllamaChatBody,
  messagesToOllama,
  createOllamaToCompletionsTransformer,
  ollamaToCompletionsResponse,
  resolveOllamaNumCtx,
  ollamaOrigin,
} from '@/lib/llm/ollama-adapter';
import { DEFAULT_LOCAL_CONTEXT_LENGTH } from '@/lib/llm/local-context';
import { parseStreamingResponse } from '@/lib/llm/streaming-parser';
import type { LLMMessage } from '@/lib/llm/types';

/**
 * Stream fixtures are lines captured from Ollama 0.34's `/api/chat` with qwen3:4b on
 * 2026-09-17. They run through the transformer and then the real client parser, so the
 * assertions are on what the app sees.
 */

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

async function throughParser(lines: string[], split = false) {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) {
        if (split) {
          const mid = Math.floor(l.length / 2);
          controller.enqueue(encoder.encode(l.slice(0, mid)));
          controller.enqueue(encoder.encode(l.slice(mid)));
        } else {
          controller.enqueue(encoder.encode(l));
        }
      }
      controller.close();
    },
  });
  return parseStreamingResponse(
    new Response(upstream.pipeThrough(createOllamaToCompletionsTransformer())),
    { provider: 'ollama', model: 'qwen3:4b' },
  );
}

const DONE = { model: 'qwen3:4b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 134, eval_count: 206 };

describe('createOllamaToCompletionsTransformer', () => {
  it('turns a native tool_calls chunk into a tool call the parser can execute', async () => {
    const result = await throughParser([
      line({ model: 'qwen3:4b', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_hxrn6il6', function: { index: 0, name: 'bash', arguments: { command: 'echo hi' } } }] }, done: false }),
      line(DONE),
    ]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toMatchObject({ id: 'call_hxrn6il6', function: { name: 'bash' } });
    expect(JSON.parse(result.toolCalls![0].function.arguments)).toEqual({ command: 'echo hi' });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toMatchObject({ promptTokens: 134, completionTokens: 206, totalTokens: 340 });
  });

  it('streams thinking as reasoning and content as content', async () => {
    const seen: string[] = [];
    const encoder = new TextEncoder();
    const lines = [
      line({ message: { role: 'assistant', content: '', thinking: 'Okay' }, done: false }),
      line({ message: { role: 'assistant', content: '', thinking: ', the' }, done: false }),
      line({ message: { role: 'assistant', content: 'Hi' }, done: false }),
      line({ message: { role: 'assistant', content: ' there' }, done: false }),
      line(DONE),
    ];
    const upstream = new ReadableStream<Uint8Array>({
      start(c) { lines.forEach(l => c.enqueue(encoder.encode(l))); c.close(); },
    });
    const result = await parseStreamingResponse(
      new Response(upstream.pipeThrough(createOllamaToCompletionsTransformer())),
      { provider: 'ollama', model: 'qwen3:4b', onProgress: (e, d) => { if (e === 'assistant_delta') seen.push(d.text); } },
    );

    expect(result.reasoning).toBe('Okay, the');
    expect(result.content).toBe('Hi there');
    expect(seen).toEqual(['Hi', ' there']);
    expect(result.finishReason).toBe('stop');
  });

  it('reports done_reason length as a truncated response', async () => {
    const result = await throughParser([
      line({ message: { role: 'assistant', content: 'partial' }, done: false }),
      line({ ...DONE, done_reason: 'length' }),
    ]);

    expect(result.wasTruncated).toBe(true);
    expect(result.finishReason).toBe('length');
  });

  it('survives NDJSON lines that arrive split mid-line', async () => {
    const result = await throughParser([
      line({ message: { role: 'assistant', content: 'Hello' }, done: false }),
      line({ message: { role: 'assistant', content: ' world' }, done: false }),
      line(DONE),
    ], true);

    expect(result.content).toBe('Hello world');
  });

  it('numbers parallel tool calls without ids so the parser keeps them apart', async () => {
    const result = await throughParser([
      line({ message: { role: 'assistant', content: '', tool_calls: [
        { function: { name: 'bash', arguments: { command: 'ls' } } },
        { function: { name: 'bash', arguments: { command: 'pwd' } } },
      ] }, done: false }),
      line(DONE),
    ]);

    expect(result.toolCalls!.map(t => JSON.parse(t.function.arguments).command)).toEqual(['ls', 'pwd']);
    expect(new Set(result.toolCalls!.map(t => t.id)).size).toBe(2);
  });

  it('surfaces an error line as a parser-visible error', async () => {
    const result = await throughParser([line({ error: 'model requires more system memory' })]);

    expect(result.midstreamError?.message).toBe('model requires more system memory');
  });

  it('closes the stream when the done line never arrives', async () => {
    const result = await throughParser([line({ message: { role: 'assistant', content: 'cut' }, done: false })]);

    expect(result.content).toBe('cut');
    expect(result.finishReason).toBe('stop');
  });
});

describe('messagesToOllama', () => {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Make a page.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'index.html' },
  ];

  it('replays a tool call with its arguments as an object', () => {
    expect(messagesToOllama(messages)[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'bash', arguments: { command: 'ls' } } }],
    });
  });

  it('names the function a tool result answers', () => {
    expect(messagesToOllama(messages)[3]).toEqual({ role: 'tool', content: 'index.html', tool_name: 'bash' });
  });

  it('moves an attached image onto the message as base64', () => {
    const [m] = messagesToOllama([{
      role: 'user',
      content: [{ type: 'text', text: 'Match this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    }]);

    expect(m).toEqual({ role: 'user', content: 'Match this', images: ['AAAA'] });
  });

  it('treats unparseable tool arguments as an empty object', () => {
    const [m] = messagesToOllama([{ role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'bash', arguments: '{oops' } }] }]);

    expect(m.tool_calls![0].function.arguments).toEqual({});
  });
});

describe('buildOllamaChatBody', () => {
  it('puts the context window, output cap and temperature in options and declares tools', () => {
    const body = buildOllamaChatBody([{ role: 'user', content: 'hi' }], {
      model: 'qwen3:4b', stream: true, numCtx: 32768, maxTokens: 4096, temperature: 0.7,
      tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
    });

    expect(body.options).toEqual({ num_ctx: 32768, num_predict: 4096, temperature: 0.7 });
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }]);
    expect(body.stream).toBe(true);
  });
});

describe('resolveOllamaNumCtx', () => {
  it('asks for the default window and caps it at the model limit', () => {
    expect(resolveOllamaNumCtx(undefined)).toBe(DEFAULT_LOCAL_CONTEXT_LENGTH);
    expect(resolveOllamaNumCtx(262144)).toBe(DEFAULT_LOCAL_CONTEXT_LENGTH);
    expect(resolveOllamaNumCtx(8192)).toBe(8192);
  });

  it('uses the provider setting when one is given, still capped at the model limit', () => {
    expect(resolveOllamaNumCtx(262144, 65536)).toBe(65536);
    expect(resolveOllamaNumCtx(undefined, 16384)).toBe(16384);
    expect(resolveOllamaNumCtx(8192, 65536)).toBe(8192);
    expect(resolveOllamaNumCtx(262144, 0)).toBe(DEFAULT_LOCAL_CONTEXT_LENGTH);
  });
});

describe('ollamaOrigin', () => {
  it('strips the OpenAI-compatible suffix the registry carries', () => {
    expect(ollamaOrigin('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(ollamaOrigin('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434');
    expect(ollamaOrigin('http://box:11434')).toBe('http://box:11434');
  });
});

describe('ollamaToCompletionsResponse', () => {
  it('shapes a non-streamed tool call like a chat completion', () => {
    const out = ollamaToCompletionsResponse({
      model: 'qwen3:4b',
      message: { role: 'assistant', content: '', thinking: 'plan', tool_calls: [{ id: 'call_9', function: { name: 'bash', arguments: { command: 'ls' } } }] },
      done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 4,
    }) as any;

    expect(out.choices[0].finish_reason).toBe('tool_calls');
    expect(out.choices[0].message.tool_calls).toEqual([{ id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }]);
    expect(out.choices[0].message.reasoning).toBe('plan');
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  });
});
