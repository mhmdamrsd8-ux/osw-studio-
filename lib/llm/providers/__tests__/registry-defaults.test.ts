import { describe, it, expect } from 'vitest';
import { getDefaultModel, getProvider } from '@/lib/llm/providers/registry';
import type { BuiltInProviderId } from '@/lib/llm/providers/types';

/**
 * The default model each provider starts on.
 *
 * `getDefaultModel` is a switch with a `default` arm, so a provider with no case of its own does
 * not fail loudly: it silently returns another vendor's slug. `deepseek` was in that state, handing
 * api.deepseek.com an OpenRouter-style `minimax/minimax-m2.7` that it rejects.
 *
 * The sweep below is the part that matters. A new built-in provider added without a case is caught
 * here rather than by a user whose first task fails.
 */

const BUILT_INS: BuiltInProviderId[] = [
  'openrouter', 'openai', 'openai-codex', 'anthropic', 'groq', 'gemini', 'huggingface',
  'ollama', 'lmstudio', 'sambanova', 'deepseek', 'zhipu', 'minimax', 'llamacpp', 'meshllm',
  'opencode-go',
];

/** Providers that intentionally have no default: the user picks from a discovered list. */
const NO_DEFAULT: BuiltInProviderId[] = ['opencode-go', 'meshllm'];

describe('getDefaultModel', () => {
  it('gives deepseek a model its own API accepts', () => {
    // Native naming, no vendor prefix. Real traffic on this provider uses `deepseek-v4-flash`.
    expect(getDefaultModel('deepseek')).toBe('deepseek-v4-flash');
  });

  it('gives no built-in provider a model belonging to another vendor', () => {
    // A prefix is not the tell: huggingface's router legitimately uses `org/model`. What is wrong
    // is any provider receiving the switch's fallthrough, which is the bug deepseek and meshllm
    // were both in. Asserting on the fallthrough value catches exactly that and nothing else.
    for (const provider of BUILT_INS) {
      expect(getDefaultModel(provider), provider).not.toBe('minimax/minimax-m2.7');
    }
  });

  it('returns no model for an unknown id instead of inventing one', () => {
    // The fallthrough arm itself. A stale id from localStorage should read as "nothing selected".
    expect(getDefaultModel('some-provider-that-was-removed')).toBe('');
  });

  it('returns something for every built-in that should have one', () => {
    for (const provider of BUILT_INS) {
      if (NO_DEFAULT.includes(provider)) continue;
      expect(getDefaultModel(provider), provider).not.toBe('');
    }
  });

  it('covers every provider the registry actually defines', () => {
    // The control: if BUILT_INS drifts from the registry, the sweeps above go quietly stale.
    for (const provider of BUILT_INS) {
      expect(getProvider(provider), provider).toBeTruthy();
    }
  });
});
