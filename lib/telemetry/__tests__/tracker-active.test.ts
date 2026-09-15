import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `isActive` is the gate for UI that exists only to produce an event. It has to agree exactly
 * with what `track` would do, or the "why did you stop?" ask appears for someone whose answer is
 * then thrown away.
 */
function stubBrowser() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, location: { hostname: 'localhost' } } as unknown as Window);
  vi.stubGlobal('document', { addEventListener: () => {}, visibilityState: 'visible' } as unknown as Document);
  vi.stubGlobal('navigator', { userAgent: 'test', platform: 'MacIntel' } as unknown as Navigator);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
}

beforeEach(() => { stubBrowser(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('TelemetryTracker.isActive', () => {
  it('is false before init, when track would drop everything', async () => {
    const { TelemetryTracker } = await import('../tracker');
    expect(new TelemetryTracker().isActive()).toBe(false);
  });

  it('is true after init with the default opt-in', async () => {
    const { TelemetryTracker } = await import('../tracker');
    const t = new TelemetryTracker();
    t.init();
    expect(t.isActive()).toBe(true);
  });

  it('is false once the user opts out', async () => {
    const { TelemetryTracker } = await import('../tracker');
    const t = new TelemetryTracker();
    t.init();
    t.setOptIn(false);
    expect(t.isActive()).toBe(false);
  });

  it('is false when the stored setting says opted out, before any UI runs', async () => {
    localStorage.setItem('osw-studio-settings', JSON.stringify({ telemetryOptIn: false }));
    const { TelemetryTracker } = await import('../tracker');
    const t = new TelemetryTracker();
    t.init();
    expect(t.isActive()).toBe(false);
  });
});
