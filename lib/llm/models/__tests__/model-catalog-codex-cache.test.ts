import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/llm/models-dev', () => ({
  enrichModelsFromModelsDev: vi.fn(async () => {}),
  loadModelsFromModelsDev: vi.fn(async () => []),
}));
vi.mock('@/lib/llm/models-api', () => ({ fetchAvailableModels: vi.fn(async () => { throw new Error('no network in this test'); }) }));
vi.mock('@/lib/llm/llm-client', () => ({ getAvailableModels: vi.fn(async () => []), normalizeModelEntry: (m: unknown) => m }));

import { configManager } from '@/lib/config/storage';
import { loadProviderModels } from '@/lib/llm/models/model-catalog';

/**
 * Codex does not advertise its image tool as a model, so the three `gpt-image-2-*` tiers are
 * local entries. The discovery route appends them on a fresh fetch; this is the other half, the
 * cache read, which is the only path an existing install takes until its 24h cache expires.
 * Without it, upgrading shows no Codex image models until the cache happens to turn over.
 */
function stubBrowserStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', { dispatchEvent: () => true } as unknown as Window);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
}

const TIERS = ['gpt-image-2-low', 'gpt-image-2-medium', 'gpt-image-2-high'];

beforeEach(stubBrowserStorage);
afterEach(() => vi.unstubAllGlobals());

describe('loadProviderModels for openai-codex, served from cache', () => {
  it('adds the local image tiers to a cached list that predates them', async () => {
    configManager.setCachedModels('openai-codex', [{ id: 'gpt-5.5', name: 'GPT-5.5', contextLength: 128000 }]);

    const ids = (await loadProviderModels('openai-codex')).map((m) => m.id);

    expect(ids).toEqual(['gpt-5.5', ...TIERS]);
  });

  it('does not duplicate tiers the cache already holds', async () => {
    configManager.setCachedModels('openai-codex', [
      { id: 'gpt-5.5', name: 'GPT-5.5', contextLength: 128000 },
      { id: 'gpt-image-2-low', name: 'GPT Image 2 (Low)', contextLength: 0, outputModalities: ['image'] },
    ]);

    const ids = (await loadProviderModels('openai-codex')).map((m) => m.id);

    expect(ids.filter((id) => id === 'gpt-image-2-low')).toHaveLength(1);
    expect(ids).toEqual(expect.arrayContaining(TIERS));
  });

  it('leaves another provider\'s cache alone', async () => {
    configManager.setCachedModels('groq', [{ id: 'llama', name: 'llama', contextLength: 8000 }]);
    configManager.setProviderApiKey('groq', 'k');

    expect((await loadProviderModels('groq')).map((m) => m.id)).toEqual(['llama']);
  });
});
