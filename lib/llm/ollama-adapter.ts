/**
 * Ollama adapter: talks to Ollama's native `/api/chat` instead of its OpenAI-compatible
 * `/v1/chat/completions`.
 *
 * The native endpoint is the only one that takes `options.num_ctx`. Ollama loads every
 * model with a 4096-token context unless told otherwise, and `/v1` silently drops the
 * start of any longer prompt; the app's system prompt alone is several times that, so
 * the model never saw the task. `/v1` ignores `options`. The window comes from the
 * provider's context-length setting (see local-context.ts).
 *
 * `createOllamaToCompletionsTransformer` rewrites the native NDJSON stream into Chat
 * Completions SSE so the client parser needs no Ollama branch.
 */

import type { LLMMessage, ContentBlock, ToolCall } from './types';

import { resolveLocalContextLength } from './local-context';

/** The window to load with: the user's context length (or the default), capped at the model's limit. */
export function resolveOllamaNumCtx(modelContextLength: number | undefined, requested?: number): number {
  const wanted = resolveLocalContextLength(requested);
  if (modelContextLength && modelContextLength > 0) return Math.min(wanted, modelContextLength);
  return wanted;
}

/** `http://127.0.0.1:11434/v1` → `http://127.0.0.1:11434` */
export function ollamaOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function textOf(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function imagesOf(content: string | ContentBlock[]): string[] {
  if (typeof content === 'string') return [];
  const images: string[] = [];
  for (const block of content) {
    if (block.type !== 'image_url') continue;
    const match = block.image_url.url.match(/^data:[^;]+;base64,(.+)$/);
    if (match) images.push(match[1]);
  }
  return images;
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

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
};

export function messagesToOllama(messages: LLMMessage[]): OllamaMessage[] {
  const callNames = new Map<string, string>();
  const out: OllamaMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const name = msg.tool_call_id ? callNames.get(msg.tool_call_id) : undefined;
      out.push({ role: 'tool', content: textOf(msg.content), ...(name ? { tool_name: name } : {}) });
      continue;
    }
    const m: OllamaMessage = { role: msg.role, content: textOf(msg.content) };
    const images = imagesOf(msg.content);
    if (images.length > 0) m.images = images;
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      m.tool_calls = msg.tool_calls.map((call) => {
        callNames.set(call.id, call.function.name);
        return { function: { name: call.function.name, arguments: parseArgs(call.function.arguments) } };
      });
    }
    out.push(m);
  }
  return out;
}

export interface OllamaRequestOptions {
  model: string;
  stream: boolean;
  numCtx: number;
  maxTokens?: number;
  temperature?: number;
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
}

export function buildOllamaChatBody(messages: LLMMessage[], options: OllamaRequestOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: messagesToOllama(messages),
    stream: options.stream,
    options: {
      num_ctx: options.numCtx,
      ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    },
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
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
};

type OllamaMessageChunk = {
  role?: string;
  content?: string;
  thinking?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
};

function messageToDelta(message: OllamaMessageChunk | undefined, state: { toolCalls: number }): CompletionsDelta {
  const delta: CompletionsDelta = {};
  if (message?.thinking) delta.reasoning = String(message.thinking);
  if (message?.content) delta.content = String(message.content);
  for (const call of message?.tool_calls ?? []) {
    const index = state.toolCalls++;
    (delta.tool_calls ??= []).push({
      index,
      id: call.id || `call_${index}`,
      type: 'function',
      function: { name: call.function?.name ?? '', arguments: JSON.stringify(call.function?.arguments ?? {}) },
    });
  }
  return delta;
}

function finishReason(doneReason: string | undefined, sawToolCall: boolean): string {
  if (doneReason === 'length') return 'length';
  return sawToolCall ? 'tool_calls' : 'stop';
}

function usageOf(event: { prompt_eval_count?: number; eval_count?: number } | undefined): Record<string, number> | undefined {
  if (typeof event?.prompt_eval_count !== 'number' && typeof event?.eval_count !== 'number') return undefined;
  const prompt = event.prompt_eval_count ?? 0;
  const completion = event.eval_count ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

export function createOllamaToCompletionsTransformer(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state = { toolCalls: 0 };
  let buffer = '';
  let finished = false;

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, chunk: unknown) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  const handle = (controller: TransformStreamDefaultController<Uint8Array>, line: string) => {
    let event: { error?: unknown; message?: OllamaMessageChunk; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.error) {
      emit(controller, { choices: [], error: typeof event.error === 'string' ? { message: event.error } : event.error });
      return;
    }
    const delta = messageToDelta(event.message, state);
    if (Object.keys(delta).length > 0) {
      emit(controller, { choices: [{ index: 0, delta, finish_reason: null }] });
    }
    if (event.done && !finished) {
      finished = true;
      const chunk: Record<string, unknown> = {
        choices: [{ index: 0, delta: {}, finish_reason: finishReason(event.done_reason, state.toolCalls > 0) }],
      };
      const usage = usageOf(event);
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
        if (trimmed) handle(controller, trimmed);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed) handle(controller, trimmed);
      if (!finished) {
        finished = true;
        emit(controller, { choices: [{ index: 0, delta: {}, finish_reason: finishReason(undefined, state.toolCalls > 0) }] });
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  });
}

/** Non-streamed `/api/chat` body → Chat Completions response. */
export function ollamaToCompletionsResponse(body: { model?: string; message?: OllamaMessageChunk; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number }): Record<string, unknown> {
  const delta = messageToDelta(body?.message, { toolCalls: 0 });
  const message: Record<string, unknown> = { role: 'assistant', content: delta.content ?? '' };
  if (delta.reasoning) message.reasoning = delta.reasoning;
  if (delta.tool_calls) {
    message.tool_calls = delta.tool_calls.map(({ index: _index, ...call }): ToolCall => call);
  }
  const response: Record<string, unknown> = {
    object: 'chat.completion',
    model: body?.model,
    choices: [{ index: 0, message, finish_reason: finishReason(body?.done_reason, Boolean(delta.tool_calls)) }],
  };
  const usage = usageOf(body);
  if (usage) response.usage = usage;
  return response;
}
