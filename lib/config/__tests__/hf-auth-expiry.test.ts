import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configManager } from '@/lib/config/storage';

/**
 * An expired HuggingFace sign-in is dropped before it is sent.
 *
 * The OAuth token HF hands out dies after a few hours. It used to be stored without its expiry
 * and sent until HF refused it, which the user saw as a 401 on every task with Settings still
 * reading "Connected". `getProviderApiKey` is the one place every request path reads the key,
 * so that is where an expired token is discarded.
 */

const dispatched: string[] = [];
const details: unknown[] = [];

function stubBrowserStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', { dispatchEvent: (e: Event) => { dispatched.push(e.type); details.push((e as CustomEvent).detail); return true; } } as unknown as Window);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
}

beforeEach(() => { dispatched.length = 0; details.length = 0; stubBrowserStorage(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('an OAuth token with an expiry', () => {
  it('is returned while it is still valid', () => {
    configManager.setHFAuth({ access_token: 'hf_live', username: 'u', expires_at: Date.now() + 60_000 });

    expect(configManager.isHFAuthExpired()).toBe(false);
    expect(configManager.getProviderApiKey('huggingface')).toBe('hf_live');
  });

  it('is dropped, not sent, once past its expiry', () => {
    configManager.setHFAuth({ access_token: 'hf_dead', username: 'u', expires_at: Date.now() - 1 });

    expect(configManager.getProviderApiKey('huggingface')).toBeNull();
    // The auth itself is gone, so Settings stops saying "Connected".
    expect(configManager.getHFAuth()).toBeNull();
    // And the UI is told which provider changed: the HF panel only updates its "Connected" row
    // when the event names it, so a bare event would leave Settings saying the opposite.
    expect(dispatched).toContain('apiKeyUpdated');
    expect(details).toContainEqual({ provider: 'huggingface', hasKey: false });
  });

  it('expires at the boundary, not one tick after', () => {
    configManager.setHFAuth({ access_token: 'hf_edge', username: 'u', expires_at: Date.now() });

    expect(configManager.isHFAuthExpired()).toBe(true);
  });
});

describe('a pasted token, which has no expiry', () => {
  it('never expires here; only HF itself can refuse it', () => {
    configManager.setHFAuth({ access_token: 'hf_pasted', username: 'u' });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

    expect(configManager.isHFAuthExpired()).toBe(false);
    expect(configManager.getProviderApiKey('huggingface')).toBe('hf_pasted');
    expect(dispatched).not.toContain('apiKeyUpdated');
  });
});

describe('other providers', () => {
  it('are untouched by the HuggingFace check', () => {
    configManager.setHFAuth({ access_token: 'hf_dead', username: 'u', expires_at: Date.now() - 1 });
    configManager.setProviderApiKey('openai', 'sk-openai');

    expect(configManager.getProviderApiKey('openai')).toBe('sk-openai');
  });
});
