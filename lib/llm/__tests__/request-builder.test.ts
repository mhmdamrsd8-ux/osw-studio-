import { describe, it, expect } from 'vitest';
import { getApiEndpoint, buildHeaders, resolveTemperature } from '@/lib/llm/request-builder';
import { getProvider } from '@/lib/llm/providers/registry';

describe('getApiEndpoint', () => {
  it('opencode-go + minimax model + anthropic wire → /messages on opencode-go base URL', () => {
    const result = getApiEndpoint('opencode-go', getProvider('opencode-go'), 'minimax-m2.7', {}, undefined, 'anthropic');
    expect(result).toBe('https://opencode.ai/zen/go/v1/messages');
  });

  it('anthropic provider + anthropic wire → api.anthropic.com/v1/messages', () => {
    const result = getApiEndpoint('anthropic', getProvider('anthropic'), 'claude-x', {}, undefined, 'anthropic');
    expect(result).toBe('https://api.anthropic.com/v1/messages');
  });

  it('opencode-go + glm model + openai wire → /chat/completions on opencode-go base URL', () => {
    const result = getApiEndpoint('opencode-go', getProvider('opencode-go'), 'glm-5.2', {}, undefined, 'openai');
    expect(result).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  });
});

describe('buildHeaders', () => {
  it('opencode-go + anthropic wire → x-api-key and anthropic-version, no anthropic-beta', () => {
    const headers = buildHeaders('opencode-go', 'sk-x', getProvider('opencode-go'), 'anthropic');
    expect(headers['x-api-key']).toBe('sk-x');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('anthropic provider + anthropic wire → x-api-key AND anthropic-beta (supportsFunctions=true)', () => {
    const config = getProvider('anthropic');
    expect(config.supportsFunctions).toBe(true); // guard assertion
    const headers = buildHeaders('anthropic', 'sk-x', config, 'anthropic');
    expect(headers['x-api-key']).toBe('sk-x');
    expect(headers['anthropic-beta']).toBe('tools-2024-04-04');
  });

  it('opencode-go + openai wire → Authorization Bearer, no x-api-key', () => {
    const headers = buildHeaders('opencode-go', 'sk-x', getProvider('opencode-go'), 'openai');
    expect(headers['Authorization']).toBe('Bearer sk-x');
    expect(headers['x-api-key']).toBeUndefined();
  });
});

describe('OpenRouter attribution', () => {
  it('names the app, not whatever host served it', () => {
    // OpenRouter attributes requests on its public per-model app rankings by these two headers.
    // They used to carry the incoming request's referer, so the HF Space credited hf.space and a
    // local instance credited localhost, splitting attribution and crediting neither.
    const headers = buildHeaders('openrouter', 'sk-x', getProvider('openrouter'), 'openai');

    expect(headers['HTTP-Referer']).toBe('https://oswstudio.com');
    expect(headers['X-Title']).toBe('OSW Studio');
  });

  it('is the same pair the model listing sends', async () => {
    // The two call sites drifted apart once already. Asserting they share the constant is what
    // keeps a change to one from silently leaving the other behind.
    const { OPENROUTER_ATTRIBUTION } = await import('@/lib/llm/request-builder');
    const headers = buildHeaders('openrouter', 'sk-x', getProvider('openrouter'), 'openai');

    for (const [key, value] of Object.entries(OPENROUTER_ATTRIBUTION)) {
      expect(headers[key]).toBe(value);
    }
  });

  it('sends attribution on no other provider', () => {
    const headers = buildHeaders('openai', 'sk-x', getProvider('openai'), 'openai');

    expect(headers['HTTP-Referer']).toBeUndefined();
    expect(headers['X-Title']).toBeUndefined();
  });
});

describe('buildHeaders custom headers', () => {
  const custom = getProvider('some-unregistered-custom-id');

  it('forwards a configured header alongside the Bearer token', () => {
    const headers = buildHeaders('some-unregistered-custom-id', 'sk-x', custom, 'openai', { 'X-Tenant': 'acme' });
    expect(headers['Authorization']).toBe('Bearer sk-x');
    expect(headers['X-Tenant']).toBe('acme');
  });

  it('sends nothing extra when none are configured (the existing Bearer-only path)', () => {
    const headers = buildHeaders('some-unregistered-custom-id', 'sk-x', custom, 'openai');
    expect(headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-x' });
  });

  it('keeps the API key when a configured header also claims Authorization', () => {
    // Precedence: the token field owns the header, so a second source cannot displace it.
    const headers = buildHeaders('some-unregistered-custom-id', 'sk-x', custom, 'openai', {
      Authorization: 'Bearer other',
      'X-Tenant': 'acme',
    });
    expect(headers['Authorization']).toBe('Bearer sk-x');
    expect(headers['X-Tenant']).toBe('acme');
  });

  it('does not let a configured header replace Content-Type', () => {
    const headers = buildHeaders('some-unregistered-custom-id', 'sk-x', custom, 'openai', {
      'Content-Type': 'text/plain',
    });
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('drops a rejected name rather than passing it to fetch', () => {
    const headers = buildHeaders('some-unregistered-custom-id', undefined, custom, 'openai', {
      Host: 'evil.example',
      Connection: 'keep-alive',
      'X-Tenant': 'acme',
    });
    expect(headers['Host']).toBeUndefined();
    expect(headers['Connection']).toBeUndefined();
    expect(headers['X-Tenant']).toBe('acme');
  });
});

describe('resolveTemperature', () => {
  it('opencode-go + kimi- model → 1', () => {
    expect(resolveTemperature('opencode-go', 'kimi-k2.7-code')).toBe(1);
  });

  it('opencode-go + non-kimi model → 0.7', () => {
    expect(resolveTemperature('opencode-go', 'glm-5.2')).toBe(0.7);
  });

  it('openai + gpt-5-nano → 1', () => {
    expect(resolveTemperature('openai', 'gpt-5-nano')).toBe(1);
  });

  it('anthropic + claude-x → 0.7', () => {
    expect(resolveTemperature('anthropic', 'claude-x')).toBe(0.7);
  });
});
