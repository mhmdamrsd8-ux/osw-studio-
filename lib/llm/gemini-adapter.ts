/**
 * Gemini adapter: converts between the OpenAI-shaped messages the app speaks and
 * Google's native generateContent API, in both directions.
 *
 * Request side: `messagesToGeminiContents` turns system/user/assistant/tool messages
 * into `contents` + `system_instruction`, replaying prior tool calls as
 * `functionCall` parts and tool results as `functionResponse` parts.
 *
 * Response side: `createGeminiToCompletionsTransformer` rewrites Gemini's SSE
 * (`candidates[].content.parts[]`) into Chat Completions deltas so the client-side
 * streaming parser needs no Gemini branch. `geminiToCompletionsResponse` does the
 * same for a non-streamed body.
 *
 * Thought signatures: Gemini 3.x returns a `thoughtSignature` on the parts of a
 * model turn and rejects the next request (400) if a replayed `functionCall` lacks
 * it. The transformer emits each signature as a `reasoning_details` entry of type
 * `gemini.thought_signature` whose `id` is the tool call id (or `text` for a text
 * part); the client stores those on the assistant message and the request side
 * puts them back on the matching part.
 */

import type { LLMMessage, ContentBlock, ReasoningDetail } from './types';

export const GEMINI_SIGNATURE_TYPE = 'gemini.thought_signature';
const TEXT_SIGNATURE_ID = 'text';
/**
 * Google's documented placeholder for a function call that has no signature: one
 * made by another provider, or by Gemini before signatures were stored. Without it
 * Gemini 3.x rejects the whole request.
 */
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';

type GeminiPart = Record<string, unknown>;
type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function contentParts(content: string | ContentBlock[]): GeminiPart[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  const parts: GeminiPart[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) parts.push({ text: block.text });
    } else if (block.type === 'image_url') {
      const parsed = parseDataUrl(block.image_url.url);
      if (parsed) parts.push({ inline_data: { mime_type: parsed.mediaType, data: parsed.data } });
    }
  }
  return parts;
}

function parseArgs(args: string): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function signaturesOf(details: ReasoningDetail[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const rd of details ?? []) {
    if (rd.type === GEMINI_SIGNATURE_TYPE && rd.signature && rd.id) map.set(rd.id, rd.signature);
  }
  return map;
}

/** Append `parts` to the last content when it has the same role, else start a new one. */
function push(contents: GeminiContent[], role: 'user' | 'model', parts: GeminiPart[]): void {
  if (parts.length === 0) return;
  const last = contents[contents.length - 1];
  if (last && last.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
}

export function messagesToGeminiContents(messages: LLMMessage[]): {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
} {
  const contents: GeminiContent[] = [];
  const systemTexts: string[] = [];
  // Tool call id → function name, so a tool result can name the function it answers.
  const callNames = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = textOf(msg.content);
      if (text) systemTexts.push(text);
      continue;
    }

    if (msg.role === 'tool') {
      const name = (msg.tool_call_id && callNames.get(msg.tool_call_id)) || 'tool';
      const part: GeminiPart = {
        functionResponse: {
          name,
          response: { output: textOf(msg.content) },
          ...(msg.tool_call_id ? { id: msg.tool_call_id } : {}),
        },
      };
      push(contents, 'user', [part]);
      continue;
    }

    if (msg.role === 'assistant') {
      const signatures = signaturesOf(msg.reasoning_details);
      const parts = contentParts(msg.content);
      const textSignature = signatures.get(TEXT_SIGNATURE_ID);
      if (parts.length > 0 && textSignature) parts[0].thoughtSignature = textSignature;

      let spareSignature = parts.length === 0 ? textSignature : undefined;
      for (const call of msg.tool_calls ?? []) {
        callNames.set(call.id, call.function.name);
        const part: GeminiPart = {
          functionCall: { name: call.function.name, args: parseArgs(call.function.arguments), id: call.id },
        };
        const signature = signatures.get(call.id) ?? spareSignature;
        part.thoughtSignature = signature ?? GEMINI_SKIP_SIGNATURE;
        if (signature) spareSignature = undefined;
        parts.push(part);
      }
      push(contents, 'model', parts);
      continue;
    }

    push(contents, 'user', contentParts(msg.content));
  }

  return {
    contents,
    systemInstruction: systemTexts.length > 0 ? { parts: [{ text: systemTexts.join('\n\n') }] } : undefined,
  };
}

export interface GeminiRequestOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
}

export function buildGeminiRequestBody(messages: LLMMessage[], options: GeminiRequestOptions): Record<string, unknown> {
  const { contents, systemInstruction } = messagesToGeminiContents(messages);
  const body: Record<string, unknown> = { contents };
  if (systemInstruction) body.system_instruction = systemInstruction;

  const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
  // 2.5 models think without bound unless told otherwise; 3.x pick a dynamic budget themselves.
  if (options.model.includes('2.5')) thinkingConfig.thinkingBudget = 4096;

  body.generationConfig = {
    maxOutputTokens: options.maxTokens || 4096,
    temperature: options.temperature ?? 0.7,
    thinkingConfig,
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = [{
      function_declarations: options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }];
  }

  return body;
}

// ---------------------------------------------------------------------------
// Response conversion
// ---------------------------------------------------------------------------

type CompletionsDelta = {
  content?: string;
  reasoning?: string;
  tool_calls?: Array<{ index: number; id: string; type: 'function'; function: { name: string; arguments: string } }>;
  reasoning_details?: ReasoningDetail[];
};

function mapFinishReason(reason: string | undefined, sawToolCall: boolean): string {
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'STOP' || reason === undefined) return sawToolCall ? 'tool_calls' : 'stop';
  return 'content_filter';
}

function mapUsage(meta: Record<string, number> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const prompt = meta.promptTokenCount ?? 0;
  const thoughts = meta.thoughtsTokenCount ?? 0;
  const completion = (meta.candidatesTokenCount ?? 0) + thoughts;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: meta.totalTokenCount ?? prompt + completion,
    reasoning_tokens: thoughts,
    ...(meta.cachedContentTokenCount ? { cached_tokens: meta.cachedContentTokenCount } : {}),
  };
}

/**
 * Folds one Gemini response object (a stream chunk or a whole body) into a delta.
 * `state` carries the tool call counter across chunks of one stream.
 */
function partsToDelta(
  parts: GeminiPart[],
  state: { toolCalls: number },
): CompletionsDelta {
  const delta: CompletionsDelta = {};
  for (const part of parts) {
    const fc = part.functionCall as { name?: string; args?: unknown; id?: string } | undefined;
    if (fc) {
      const index = state.toolCalls++;
      const id = fc.id || `call_${index}`;
      (delta.tool_calls ??= []).push({
        index,
        id,
        type: 'function',
        function: { name: fc.name ?? '', arguments: JSON.stringify(fc.args ?? {}) },
      });
      if (typeof part.thoughtSignature === 'string') {
        (delta.reasoning_details ??= []).push({ type: GEMINI_SIGNATURE_TYPE, id, signature: part.thoughtSignature });
      }
      continue;
    }
    if (typeof part.text === 'string') {
      if (part.thought) delta.reasoning = (delta.reasoning ?? '') + part.text;
      else delta.content = (delta.content ?? '') + part.text;
      if (typeof part.thoughtSignature === 'string') {
        (delta.reasoning_details ??= []).push({ type: GEMINI_SIGNATURE_TYPE, id: TEXT_SIGNATURE_ID, signature: part.thoughtSignature });
      }
    }
  }
  return delta;
}

export function createGeminiToCompletionsTransformer(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state = { toolCalls: 0 };
  let buffer = '';
  let finished = false;

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, chunk: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  const handle = (controller: TransformStreamDefaultController<Uint8Array>, dataStr: string) => {
    let event: { error?: unknown; candidates?: Array<{ content?: { parts?: GeminiPart[]; role?: string }; finishReason?: string }>; usageMetadata?: Record<string, number> };
    try {
      event = JSON.parse(dataStr);
    } catch {
      return;
    }

    if (event.error) {
      emit(controller, { choices: [], error: event.error });
      return;
    }

    const candidate = event.candidates?.[0];
    const delta = partsToDelta(candidate?.content?.parts ?? [], state);
    if (Object.keys(delta).length > 0) {
      emit(controller, { choices: [{ index: 0, delta, finish_reason: null }] });
    }

    if (candidate?.finishReason && !finished) {
      finished = true;
      const chunk: Record<string, unknown> = {
        choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(candidate.finishReason, state.toolCalls > 0) }],
      };
      const usage = mapUsage(event.usageMetadata);
      if (usage) chunk.usage = usage;
      emit(controller, chunk);
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr) handle(controller, dataStr);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr) handle(controller, dataStr);
      }
      if (!finished) {
        finished = true;
        emit(controller, { choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(undefined, state.toolCalls > 0) }] });
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  });
}

/** Non-streamed Gemini body → Chat Completions response. */
export function geminiToCompletionsResponse(body: { candidates?: Array<{ content?: { parts?: GeminiPart[]; role?: string }; finishReason?: string }>; usageMetadata?: Record<string, number>; responseId?: string; modelVersion?: string }): Record<string, unknown> {
  const candidate = body?.candidates?.[0];
  const delta = partsToDelta(candidate?.content?.parts ?? [], { toolCalls: 0 });
  const message: Record<string, unknown> = { role: 'assistant', content: delta.content ?? '' };
  if (delta.reasoning) message.reasoning = delta.reasoning;
  if (delta.tool_calls) {
    message.tool_calls = delta.tool_calls.map(({ index: _index, ...call }) => call);
  }
  if (delta.reasoning_details) message.reasoning_details = delta.reasoning_details;

  const response: Record<string, unknown> = {
    id: body?.responseId,
    object: 'chat.completion',
    model: body?.modelVersion,
    choices: [{ index: 0, message, finish_reason: mapFinishReason(candidate?.finishReason, Boolean(delta.tool_calls)) }],
  };
  const usage = mapUsage(body?.usageMetadata);
  if (usage) response.usage = usage;
  return response;
}
