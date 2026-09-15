import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/llm/providers/registry', () => ({
  getProvider: (id: string) => ({ usesOAuth: id === 'huggingface' || id === 'openai-codex' }),
  getModelContextLength: () => 128000,
}));

import { isTerminalApiError } from '../multi-agent-orchestrator';
import { PausableApiError } from '../provider-adapter';

const err = (category: string, provider: string) => new PausableApiError('m', 400, 't', category, provider, 'model');

/**
 * Which API errors end the task and which pause it with Continue. A pause only helps when the
 * same request can succeed later, so the rule is about whether anything can change in between.
 */
describe('isTerminalApiError', () => {
  it('ends the task when the provider will refuse the same request every time', () => {
    for (const c of ['model_not_found', 'tool_not_supported', 'invalid_request', 'context_too_long']) {
      expect(isTerminalApiError(err(c, 'openai')), c).toBe(true);
    }
  });

  it('pauses on a transient failure, where a resend can pass', () => {
    for (const c of ['server_error', 'rate_limited', 'midstream_error', 'unknown']) {
      expect(isTerminalApiError(err(c, 'openai')), c).toBe(false);
    }
  });

  it('ends the task for an expired OAuth sign-in, which the adapter has just cleared', () => {
    expect(isTerminalApiError(err('auth_expired', 'huggingface'))).toBe(true);
  });

  it('pauses for a refused pasted key, which the user can replace and Continue', () => {
    expect(isTerminalApiError(err('auth_expired', 'openai'))).toBe(false);
  });

  it('ends the task when HuggingFace free credits are gone, since only the month resets them', () => {
    expect(isTerminalApiError(err('credit_exhausted', 'huggingface'))).toBe(true);
  });

  it('pauses when a paid provider is out of credit, which a top-up fixes in place', () => {
    expect(isTerminalApiError(err('credit_exhausted', 'openrouter'))).toBe(false);
  });
});
