import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above every import and const, so the mock's own state has to be hoisted too.
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('@/lib/telemetry', () => ({ track }));
vi.mock('@/lib/config/storage', () => ({
  configManager: { getProviderApiKey: (p: string) => (p === 'openrouter' ? 'sk' : null) },
}));

import { trackAgentProviderChange } from '../provider-selection';
import type { ModelAssignment } from '@/lib/llm/models/assignment';

const a = (provider: string, model = 'm'): ModelAssignment =>
  ({ agent: { provider, model }, imageGen: null, voiceInput: null, autoCompact: true, compactLimit: null } as unknown as ModelAssignment);

/**
 * provider_selected fires when the agent's provider changes. It had one emitter, on a component
 * only an internal test page renders, so the event went quiet while looking like a funnel
 * collapse.
 */
describe('trackAgentProviderChange', () => {
  beforeEach(() => track.mockClear());

  it('fires when the provider changes, saying whether a key is set', () => {
    trackAgentProviderChange(a('huggingface'), a('openrouter'));
    expect(track).toHaveBeenCalledWith('provider_selected', { provider: 'openrouter', has_api_key: true });
  });

  it('reports has_api_key false for a provider with no key, never the key itself', () => {
    trackAgentProviderChange(a('openrouter'), a('huggingface'));
    expect(track).toHaveBeenCalledWith('provider_selected', { provider: 'huggingface', has_api_key: false });
  });

  it('stays quiet when only the model changed', () => {
    trackAgentProviderChange(a('openrouter', 'one'), a('openrouter', 'two'));
    expect(track).not.toHaveBeenCalled();
  });

  it('fires on a first selection with no previous assignment', () => {
    trackAgentProviderChange(null, a('openrouter'));
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the new assignment has no provider', () => {
    trackAgentProviderChange(a('openrouter'), null);
    expect(track).not.toHaveBeenCalled();
  });
});
