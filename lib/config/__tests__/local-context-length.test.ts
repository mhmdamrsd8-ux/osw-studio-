import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configManager } from '@/lib/config/storage';

/**
 * The per-provider context length for local model servers, stored under
 * `localContextLengths` in the settings blob. Empty means "use the default", so clearing
 * removes the key rather than storing 0.
 */

function stubBrowserStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn(), localStorage: globalThis.localStorage });
}

beforeEach(() => stubBrowserStorage());
afterEach(() => vi.unstubAllGlobals());

describe('configManager local context length', () => {
  it('is unset by default', () => {
    expect(configManager.getLocalContextLength('ollama')).toBeUndefined();
  });

  it('stores a value per provider', () => {
    configManager.setLocalContextLength('ollama', 65536);
    configManager.setLocalContextLength('llamacpp', 8192);

    expect(configManager.getLocalContextLength('ollama')).toBe(65536);
    expect(configManager.getLocalContextLength('llamacpp')).toBe(8192);
    expect(configManager.getLocalContextLength('lmstudio')).toBeUndefined();
  });

  it('removes the key when cleared', () => {
    configManager.setLocalContextLength('ollama', 65536);
    configManager.setLocalContextLength('ollama', undefined);

    expect(configManager.getLocalContextLength('ollama')).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('osw-studio-settings') ?? '{}').localContextLengths).toEqual({});
  });
});
