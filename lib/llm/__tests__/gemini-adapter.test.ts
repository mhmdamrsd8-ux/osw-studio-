import { describe, it, expect } from 'vitest';
import {
  messagesToGeminiContents,
  buildGeminiRequestBody,
  createGeminiToCompletionsTransformer,
  geminiToCompletionsResponse,
  GEMINI_SIGNATURE_TYPE,
  GEMINI_SKIP_SIGNATURE,
} from '@/lib/llm/gemini-adapter';
import { parseStreamingResponse } from '@/lib/llm/streaming-parser';
import type { LLMMessage } from '@/lib/llm/types';

/**
 * Fixtures are trimmed copies of real generateContent responses captured on
 * 2026-09-17 from gemini-2.5-flash and gemini-3.8-flash. The stream tests run the
 * transformer's output through the real client parser, so they assert what the
 * app will see rather than the transformer's own idea of its output.
 */

const SIG = 'CiQBEU0yD0nVK0EFJnefkC+3as3SpKZtKwRsK7XnWCzZvmp+kgwKaAERTTIP';

function chunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\r\n\r\n`;
}

/** Feed raw Gemini SSE through the transformer and the real parser. */
async function throughParser(rawChunks: string[], split = false) {
  const encoder = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of rawChunks) {
        if (split) {
          // Break each chunk mid-line so the transformer's line buffering is exercised.
          const mid = Math.floor(c.length / 2);
          controller.enqueue(encoder.encode(c.slice(0, mid)));
          controller.enqueue(encoder.encode(c.slice(mid)));
        } else {
          controller.enqueue(encoder.encode(c));
        }
      }
      controller.close();
    },
  });
  const response = new Response(upstream.pipeThrough(createGeminiToCompletionsTransformer()));
  return parseStreamingResponse(response, { provider: 'gemini', model: 'gemini-3.8-flash' });
}

describe('createGeminiToCompletionsTransformer', () => {
  it('turns a functionCall part into a tool call the parser can execute', async () => {
    const result = await throughParser([
      chunk({
        candidates: [{
          content: { parts: [{ functionCall: { name: 'bash', args: { command: 'echo hi > /index.html' } }, thoughtSignature: SIG }], role: 'model' },
          finishReason: 'STOP',
          index: 0,
        }],
        usageMetadata: { promptTokenCount: 63, candidatesTokenCount: 23, totalTokenCount: 129, thoughtsTokenCount: 43 },
      }),
    ]);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].function.name).toBe('bash');
    expect(JSON.parse(result.toolCalls![0].function.arguments)).toEqual({ command: 'echo hi > /index.html' });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toMatchObject({ promptTokens: 63, completionTokens: 66, totalTokens: 129, reasoningTokens: 43 });
  });

  it('keeps the thought signature on the assistant message keyed by the tool call id', async () => {
    const result = await throughParser([
      chunk({
        candidates: [{
          content: { parts: [{ functionCall: { name: 'bash', args: {}, id: 'call_75978' }, thoughtSignature: SIG }], role: 'model' },
          finishReason: 'STOP',
        }],
      }),
    ]);

    expect(result.toolCalls![0].id).toBe('call_75978');
    expect(result.reasoningDetails).toEqual([{ type: GEMINI_SIGNATURE_TYPE, id: 'call_75978', signature: SIG }]);
  });

  it('streams text parts as content deltas and thought parts as reasoning', async () => {
    const seen: string[] = [];
    const encoder = new TextEncoder();
    const raw = [
      chunk({ candidates: [{ content: { parts: [{ text: 'Planning', thought: true }], role: 'model' } }] }),
      chunk({ candidates: [{ content: { parts: [{ text: 'Rain' }], role: 'model' } }] }),
      chunk({ candidates: [{ content: { parts: [{ text: ' falls.' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } }),
    ];
    const upstream = new ReadableStream<Uint8Array>({
      start(c) { raw.forEach(r => c.enqueue(encoder.encode(r))); c.close(); },
    });
    const result = await parseStreamingResponse(
      new Response(upstream.pipeThrough(createGeminiToCompletionsTransformer())),
      { provider: 'gemini', model: 'gemini-2.5-flash', onProgress: (e, d) => { if (e === 'assistant_delta') seen.push(d.text); } },
    );

    expect(result.content).toBe('Rain falls.');
    expect(seen).toEqual(['Rain', ' falls.']);
    expect(result.reasoning).toBe('Planning');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls ?? []).toHaveLength(0);
  });

  it('survives SSE chunks that arrive split mid-line', async () => {
    const result = await throughParser([
      chunk({ candidates: [{ content: { parts: [{ text: 'Hello' }], role: 'model' } }] }),
      chunk({ candidates: [{ content: { parts: [{ text: ' world' }], role: 'model' }, finishReason: 'STOP' }] }),
    ], true);

    expect(result.content).toBe('Hello world');
  });

  it('numbers parallel function calls so the parser keeps them apart', async () => {
    const result = await throughParser([
      chunk({
        candidates: [{
          content: { parts: [
            { functionCall: { name: 'bash', args: { command: 'ls' } } },
            { functionCall: { name: 'bash', args: { command: 'pwd' } } },
          ], role: 'model' },
          finishReason: 'STOP',
        }],
      }),
    ]);

    expect(result.toolCalls!.map(t => JSON.parse(t.function.arguments).command)).toEqual(['ls', 'pwd']);
    expect(new Set(result.toolCalls!.map(t => t.id)).size).toBe(2);
  });

  it('reports MAX_TOKENS as a truncated response', async () => {
    const result = await throughParser([
      chunk({ candidates: [{ content: { parts: [{ text: 'partial' }], role: 'model' }, finishReason: 'MAX_TOKENS' }] }),
    ]);

    expect(result.wasTruncated).toBe(true);
    expect(result.finishReason).toBe('length');
  });

  it('passes a mid-stream error object through as a parser-visible error', async () => {
    const result = await throughParser([
      chunk({ error: { code: 503, message: 'high demand' } }),
    ]);

    expect(result.midstreamError).toEqual({ code: 503, message: 'high demand' });
  });

  it('closes the stream even when no chunk carried a finishReason', async () => {
    const result = await throughParser([
      chunk({ candidates: [{ content: { parts: [{ text: 'cut' }], role: 'model' } }] }),
    ]);

    expect(result.content).toBe('cut');
    expect(result.finishReason).toBe('stop');
  });
});

describe('messagesToGeminiContents', () => {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Make a page.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
      reasoning_details: [{ type: GEMINI_SIGNATURE_TYPE, id: 'call_1', signature: SIG }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'index.html' },
  ];

  it('replays a tool call as a functionCall part with its thought signature', () => {
    const { contents } = messagesToGeminiContents(messages);
    const model = contents.find(c => c.role === 'model')!;

    expect(model.parts).toEqual([
      { functionCall: { name: 'bash', args: { command: 'ls' }, id: 'call_1' }, thoughtSignature: SIG },
    ]);
  });

  it('replays a tool result as a functionResponse that names the function it answers', () => {
    const { contents } = messagesToGeminiContents(messages);
    const last = contents[contents.length - 1];

    expect(last.role).toBe('user');
    expect(last.parts).toEqual([{ functionResponse: { name: 'bash', response: { output: 'index.html' }, id: 'call_1' } }]);
  });

  it('lifts system messages into system_instruction and out of contents', () => {
    const { contents, systemInstruction } = messagesToGeminiContents(messages);

    expect(systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'Make a page.' }] });
  });

  it('merges parallel tool results into one user turn', () => {
    const { contents } = messagesToGeminiContents([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'bash', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'bash', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: 'one' },
      { role: 'tool', tool_call_id: 'b', content: 'two' },
    ]);

    expect(contents.map(c => c.role)).toEqual(['user', 'model', 'user']);
    expect(contents[2].parts).toHaveLength(2);
  });

  it('puts a signature that arrived on a text part back on that text part', () => {
    const { contents } = messagesToGeminiContents([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello.', reasoning_details: [{ type: GEMINI_SIGNATURE_TYPE, id: 'text', signature: SIG }] },
    ]);

    expect(contents[1].parts).toEqual([{ text: 'Hello.', thoughtSignature: SIG }]);
  });

  it('marks a tool call with no stored signature so Gemini skips validation', () => {
    // A call made by another provider before the user switched to Gemini, or by
    // Gemini before signatures were stored: Gemini 3.x rejects the replay otherwise.
    const { contents } = messagesToGeminiContents([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'old', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    ]);

    expect(contents[1].parts[0]).toMatchObject({ thoughtSignature: GEMINI_SKIP_SIGNATURE });
  });

  it('ignores reasoning details that are not Gemini signatures', () => {
    const { contents } = messagesToGeminiContents([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello.', reasoning_details: [{ type: 'thinking', text: 'hmm' }] },
    ]);

    expect(contents[1].parts).toEqual([{ text: 'Hello.' }]);
  });

  it('treats unparseable tool arguments as an empty args object', () => {
    const { contents } = messagesToGeminiContents([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'bash', arguments: '{not json' } }] },
    ]);

    expect(contents[1].parts[0]).toMatchObject({ functionCall: { name: 'bash', args: {} } });
  });
});

describe('buildGeminiRequestBody', () => {
  it('declares tools and asks for thoughts', () => {
    const body = buildGeminiRequestBody([{ role: 'user', content: 'hi' }], {
      model: 'gemini-3.8-flash',
      tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
    });

    expect(body.tools).toEqual([{ function_declarations: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }] }]);
    expect(body.generationConfig).toMatchObject({ thinkingConfig: { includeThoughts: true } });
    expect((body.generationConfig as any).thinkingConfig.thinkingBudget).toBeUndefined();
  });

  it('caps thinking on 2.5 models, which otherwise think without bound', () => {
    const body = buildGeminiRequestBody([{ role: 'user', content: 'hi' }], { model: 'gemini-2.5-flash' });

    expect((body.generationConfig as any).thinkingConfig.thinkingBudget).toBe(4096);
  });
});

describe('geminiToCompletionsResponse', () => {
  it('shapes a non-streamed tool call like a chat completion', () => {
    const out = geminiToCompletionsResponse({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'bash', args: { command: 'ls' }, id: 'call_9' }, thoughtSignature: SIG }], role: 'model' },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
      modelVersion: 'gemini-3.8-flash',
    }) as any;

    expect(out.choices[0].finish_reason).toBe('tool_calls');
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
    ]);
    expect(out.choices[0].message.reasoning_details).toEqual([{ type: GEMINI_SIGNATURE_TYPE, id: 'call_9', signature: SIG }]);
    expect(out.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
    expect(out.model).toBe('gemini-3.8-flash');
  });

  it('returns plain text as message content', () => {
    const out = geminiToCompletionsResponse({
      candidates: [{ content: { parts: [{ text: 'Hi!' }], role: 'model' }, finishReason: 'STOP' }],
    }) as any;

    expect(out.choices[0]).toMatchObject({ message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' });
  });
});
