import { describe, it, expect } from 'vitest';
import {
  buildGeminiRequestBody,
  createGeminiToCompletionsTransformer,
  GEMINI_SIGNATURE_TYPE,
} from '@/lib/llm/gemini-adapter';
import { parseStreamingResponse } from '@/lib/llm/streaming-parser';
import type { LLMMessage } from '@/lib/llm/types';

/**
 * Runs only with a real key: `GEMINI_API_KEY=... npx vitest run gemini-live`.
 *
 * One two-turn tool loop against the model that enforces thought-signature replay.
 * The fixture tests prove the adapter against captured responses; this one proves
 * the captures are still what Gemini sends. Two requests per run, so it stays
 * inside the free tier's per-minute quota.
 */

const key = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-3.8-flash';
const TOOLS = [{ name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }];

async function generate(messages: LLMMessage[]) {
  const body = buildGeminiRequestBody(messages, { model: MODEL, maxTokens: 1024, tools: TOOLS });
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return parseStreamingResponse(
    new Response(response.body!.pipeThrough(createGeminiToCompletionsTransformer())),
    { provider: 'gemini', model: MODEL },
  );
}

describe.skipIf(!key)('Gemini live', () => {
  it('completes a tool loop with the signature replayed', { timeout: 90_000 }, async () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a coding agent. Use the bash tool. After a tool result, reply with one short sentence and no further tool calls.' },
      { role: 'user', content: 'Create /index.html containing <h1>Hi</h1> using bash.' },
    ];

    const first = await generate(messages);
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls![0].function.name).toBe('bash');
    const signature = first.reasoningDetails?.find(rd => rd.type === GEMINI_SIGNATURE_TYPE);
    expect(signature?.id).toBe(first.toolCalls![0].id);

    const second = await generate([
      ...messages,
      { role: 'assistant', content: first.content ?? '', tool_calls: first.toolCalls, reasoning_details: first.reasoningDetails },
      { role: 'tool', tool_call_id: first.toolCalls![0].id, content: '' },
    ]);
    // Accepted by the API (the request without the signature is rejected with 400), and the
    // replayed turn was counted: the second prompt is the first plus the tool call and result.
    expect(second.midstreamError).toBeUndefined();
    expect(second.usage!.promptTokens).toBeGreaterThan(first.usage!.promptTokens);
  });
});
