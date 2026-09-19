import type { ProviderConfig, ProviderId } from '@/lib/llm/providers/types';
import type { WireFormat } from '@/lib/llm/providers/wire-format';
import { sanitizeCustomHeaders } from '@/lib/llm/providers/custom-headers';

/** Resolve the upstream endpoint for a request, by wire format. */
export function getApiEndpoint(
  provider: ProviderId,
  config: ProviderConfig,
  model?: string,
  options?: { apiKey?: string; stream?: boolean },
  overrideBaseUrl?: string,
  wireFormat?: WireFormat,
): string {
  const baseUrl = overrideBaseUrl || config.baseUrl || 'https://openrouter.ai/api/v1';
  if (wireFormat === 'anthropic') {
    return provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : `${baseUrl}/messages`;
  } else if (provider === 'gemini') {
    const geminiModel = model || 'gemini-3.8-flash';
    const action = options?.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const key = options?.apiKey ? `${options.stream ? '&' : '?'}key=${options.apiKey}` : '';
    return `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:${action}${key}`;
  } else {
    return `${baseUrl}/chat/completions`;
  }
}

/**
 * How OSW Studio identifies itself to OpenRouter.
 *
 * OpenRouter reads these to attribute requests on its public per-model app rankings, so they have
 * to name the app rather than whatever host it happens to be served from: the incoming request's
 * referer would split attribution between the Space, localhost and every self-hosted instance.
 *
 * `models/route.ts` sends the same pair when it lists models, which is why this is exported rather
 * than written out twice.
 */
export const OPENROUTER_ATTRIBUTION: Record<string, string> = {
  'HTTP-Referer': 'https://oswstudio.com',
  'X-Title': 'OSW Studio',
};

/** Build request headers, by wire format. */
export function buildHeaders(
  provider: ProviderId,
  apiKey: string | undefined,
  config: ProviderConfig,
  wireFormat?: WireFormat,
  overrideHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (wireFormat === 'anthropic') {
    headers['x-api-key'] = apiKey || '';
    headers['anthropic-version'] = '2023-06-01';
    if (provider === 'anthropic' && config.supportsFunctions) {
      headers['anthropic-beta'] = 'tools-2024-04-04';
    }
  } else if (provider === 'gemini') {
    // Gemini uses query-param key auth; no auth headers needed
  } else {
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (provider === 'openrouter') {
      Object.assign(headers, OPENROUTER_ATTRIBUTION);
    }
  }
  // A custom provider's config lives in the client's localStorage, so `config` is a stub here and
  // the headers arrive in the request body, the same route `baseUrl` takes. Sanitised again on this
  // side because a client is not a trust boundary, and merged last but unable to reach Authorization
  // or Content-Type, which sanitizeCustomHeaders refuses.
  Object.assign(headers, sanitizeCustomHeaders(overrideHeaders).headers);
  return headers;
}

/** Sampling temperature. A few models reject anything but 1: OpenAI's gpt-5-nano and
 *  Opencode Go's Moonshot/Kimi models. Everything else uses 0.7. */
export function resolveTemperature(provider: ProviderId, model: string): number {
  const m = (model || '').toLowerCase();
  if (provider === 'openai' && m.includes('gpt-5-nano')) return 1;
  if (provider === 'opencode-go' && m.startsWith('kimi-')) return 1;
  return 0.7;
}
