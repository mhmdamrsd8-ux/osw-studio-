import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OswsProviderAdapter, ProviderAdapterConfig } from '../provider-adapter';
import { requestSnapshotStore } from '../request-snapshot';
import type { Message } from '../core/types';

vi.mock('@/lib/api/backend-status', () => ({
  apiFetch: vi.fn(async () => makeSSEResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello.' }, index: 0, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ])),
}));

vi.mock('../models-dev', () => ({
  ensureModelsDevPricing: vi.fn(async () => {}),
}));

vi.mock('../models-api', () => ({
  fetchAvailableModels: vi.fn(async () => []),
}));

vi.mock('../pricing-cache', () => ({
  registerOpenRouterPricingFromApi: vi.fn(),
  registerPricingFromProviderModels: vi.fn(),
}));

import { apiFetch } from '@/lib/api/backend-status';
import { ensureModelsDevPricing } from '../models-dev';
import { fetchAvailableModels } from '../models-api';
import { registerOpenRouterPricingFromApi, registerPricingFromProviderModels } from '../pricing-cache';

function makeSSEResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function makeAdapter(): OswsProviderAdapter {
  const config: ProviderAdapterConfig = {
    getProviderConfig: () => ({ provider: 'openai', apiKey: 'k', model: 'gpt-test', baseUrl: undefined }),
    getApiUrl: () => 'http://localhost/api/generate',
    getReasoningEnabled: () => false,
    getDebugStreamEnabled: () => false,
    getModelPricing: () => null,
    getCachedModels: () => null,
    progress: { onEvent: vi.fn() },
  };
  return new OswsProviderAdapter(config);
}

const messages: Message[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
];

describe('OswsProviderAdapter request snapshot capture', () => {
  beforeEach(() => {
    requestSnapshotStore.setEnabled(false);
    requestSnapshotStore.clear();
  });

  it('captures the outgoing message history when capture is enabled', async () => {
    requestSnapshotStore.setEnabled(true);
    await makeAdapter().call({ messages });

    const snap = requestSnapshotStore.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.messages).toEqual(messages);
    expect(snap!.provider).toBe('openai');
    expect(snap!.model).toBe('gpt-test');
  });

  it('captures nothing when disabled', async () => {
    await makeAdapter().call({ messages });
    expect(requestSnapshotStore.getSnapshot()).toBeNull();
  });

  it('does not capture silent (compaction) calls', async () => {
    requestSnapshotStore.setEnabled(true);
    await makeAdapter().call({ messages, silent: true });
    expect(requestSnapshotStore.getSnapshot()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ensurePricing — exercised indirectly via call()
// ---------------------------------------------------------------------------

describe('OswsProviderAdapter custom headers in the request body', () => {
  function adapterWith(customHeaders?: Record<string, string>): OswsProviderAdapter {
    const config: ProviderAdapterConfig = {
      getProviderConfig: () => ({
        provider: 'my-cloud', apiKey: 'k', model: 'gpt-test',
        baseUrl: 'https://api.example.com/v1',
        ...(customHeaders ? { customHeaders } : {}),
      }),
      getApiUrl: () => 'http://localhost/api/generate',
      getReasoningEnabled: () => false,
      getDebugStreamEnabled: () => false,
      getModelPricing: () => ({ input: 1, output: 1 }),
      getCachedModels: () => null,
      progress: { onEvent: vi.fn() },
    };
    return new OswsProviderAdapter(config);
  }

  function sentBody(): Record<string, unknown> {
    const call = vi.mocked(apiFetch).mock.calls[0];
    return JSON.parse((call[1] as { body: string }).body);
  }

  beforeEach(() => vi.mocked(apiFetch).mockClear());

  it('carries a custom provider’s headers to the server', async () => {
    // A custom provider only exists in the client's localStorage, so the server cannot look these
    // up. They ride in the body like baseUrl does, and nothing else puts them there.
    await adapterWith({ 'X-Tenant': 'acme' }).call({ messages });
    expect(sentBody().customHeaders).toEqual({ 'X-Tenant': 'acme' });
    expect(sentBody().baseUrl).toBe('https://api.example.com/v1');
  });

  it('leaves the field off when the provider has none', async () => {
    await adapterWith().call({ messages });
    expect(sentBody()).not.toHaveProperty('customHeaders');
  });
});

describe('OswsProviderAdapter local context length in the request body', () => {
  function adapterWith(getLocalContextLength?: () => number | undefined): OswsProviderAdapter {
    return new OswsProviderAdapter({
      getProviderConfig: () => ({ provider: 'ollama', apiKey: '', model: 'qwen3:4b', baseUrl: 'http://127.0.0.1:11434/v1' }),
      getApiUrl: () => 'http://localhost/api/generate',
      getReasoningEnabled: () => false,
      getDebugStreamEnabled: () => false,
      getModelPricing: () => ({ input: 0, output: 0 }),
      getCachedModels: () => null,
      ...(getLocalContextLength ? { getLocalContextLength } : {}),
      progress: { onEvent: vi.fn() },
    });
  }

  function sentBody(): Record<string, unknown> {
    const call = vi.mocked(apiFetch).mock.calls[0];
    return JSON.parse((call[1] as { body: string }).body);
  }

  beforeEach(() => vi.mocked(apiFetch).mockClear());

  it('sends the window a local model should be loaded with', async () => {
    // The server applies it as Ollama's num_ctx; the client has the setting, the server does not.
    await adapterWith(() => 65536).call({ messages });
    expect(sentBody().context_length).toBe(65536);
  });

  it('sends nothing for a provider with no local window', async () => {
    await adapterWith(() => undefined).call({ messages });
    expect(sentBody()).not.toHaveProperty('context_length');
  });
});

describe('ensurePricing paths', () => {
  function makeAdapterWith(overrides: Partial<ProviderAdapterConfig>): OswsProviderAdapter {
    const config: ProviderAdapterConfig = {
      getProviderConfig: () => ({ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4', baseUrl: undefined }),
      getApiUrl: () => 'http://localhost/api/generate',
      getReasoningEnabled: () => false,
      getDebugStreamEnabled: () => false,
      getModelPricing: () => null,
      getCachedModels: () => null,
      progress: { onEvent: vi.fn() },
      ...overrides,
    };
    return new OswsProviderAdapter(config);
  }

  beforeEach(() => {
    vi.mocked(ensureModelsDevPricing).mockClear();
    vi.mocked(fetchAvailableModels).mockClear();
    vi.mocked(registerOpenRouterPricingFromApi).mockClear();
    vi.mocked(registerPricingFromProviderModels).mockClear();
  });

  it('skips all fetches when getModelPricing returns data', async () => {
    const adapter = makeAdapterWith({
      getModelPricing: () => ({ input: 3, output: 15 }),
    });

    await adapter.call({ messages });

    expect(ensureModelsDevPricing).not.toHaveBeenCalled();
  });

  it('calls ensureModelsDevPricing as fallback for non-openrouter providers', async () => {
    const adapter = makeAdapterWith({
      getModelPricing: () => null,
    });

    await adapter.call({ messages });

    expect(ensureModelsDevPricing).toHaveBeenCalled();
  });

  it('tries OpenRouter cached models before falling back to models.dev', async () => {
    let pricingCallCount = 0;
    const adapter = makeAdapterWith({
      getProviderConfig: () => ({ provider: 'openrouter', apiKey: 'k', model: 'meta-llama/llama-3', baseUrl: undefined }),
      getModelPricing: () => {
        pricingCallCount++;
        return pricingCallCount <= 1 ? null : { input: 1, output: 1 };
      },
      getCachedModels: () => ({
        models: [{ id: 'meta-llama/llama-3', supportsFunctions: true }],
      }),
    });

    await adapter.call({ messages });

    expect(registerPricingFromProviderModels).toHaveBeenCalledWith('openrouter', expect.any(Array));
    expect(ensureModelsDevPricing).not.toHaveBeenCalled();
  });

  it('falls back to models.dev when OpenRouter cached models do not cover the model', async () => {
    const adapter = makeAdapterWith({
      getProviderConfig: () => ({ provider: 'openrouter', apiKey: 'k', model: 'meta-llama/llama-3', baseUrl: undefined }),
      getModelPricing: () => null,
      getCachedModels: () => ({
        models: [{ id: 'meta-llama/llama-3' }],
      }),
    });

    await adapter.call({ messages });

    expect(fetchAvailableModels).toHaveBeenCalled();
    expect(ensureModelsDevPricing).toHaveBeenCalled();
  });

  it('caches the pricing check per provider:model — does not re-run', async () => {
    const adapter = makeAdapterWith({
      getModelPricing: () => null,
    });

    await adapter.call({ messages });
    await adapter.call({ messages });

    expect(ensureModelsDevPricing).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// A 401 from HuggingFace means the sign-in is gone
// ---------------------------------------------------------------------------

import { configManager } from '@/lib/config/storage';

function stubBrowser(dispatched: string[], details: unknown[] = []) {
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

function adapterFor(provider: string): OswsProviderAdapter {
  const config: ProviderAdapterConfig = {
    getProviderConfig: () => ({ provider, apiKey: 'k', model: 'm', baseUrl: undefined }),
    getApiUrl: () => 'http://localhost/api/generate',
    getReasoningEnabled: () => false,
    getDebugStreamEnabled: () => false,
    getModelPricing: () => null,
    getCachedModels: () => null,
    progress: { onEvent: vi.fn() },
  };
  return new OswsProviderAdapter(config);
}

describe('a 401 from the provider', () => {
  const dispatched: string[] = [];
  const details: unknown[] = [];
  beforeEach(() => {
    dispatched.length = 0;
    details.length = 0;
    stubBrowser(dispatched, details);
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Invalid username or password.' }), { status: 401 }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('drops a HuggingFace sign-in and says what happened', async () => {
    configManager.setHFAuth({ access_token: 'hf_dead', username: 'u' });

    await expect(adapterFor('huggingface').call({ messages })).rejects.toMatchObject({
      status: 401,
      errorCategory: 'auth_expired',
      message: expect.stringMatching(/sign-in has expired/i),
    });
    // The half a user could not see: the credential is gone and the UI was told.
    expect(configManager.getHFAuth()).toBeNull();
    expect(configManager.getProviderApiKey('huggingface')).toBeNull();
    expect(dispatched).toContain('apiKeyUpdated');
    expect(details).toContainEqual({ provider: 'huggingface', hasKey: false });
  });

  it('leaves a HuggingFace sign-in alone when the 401 came from another provider', async () => {
    configManager.setHFAuth({ access_token: 'hf_live', username: 'u' });

    await expect(adapterFor('openai').call({ messages })).rejects.toMatchObject({ status: 401 });
    expect(configManager.getHFAuth()?.access_token).toBe('hf_live');
    expect(dispatched).not.toContain('apiKeyUpdated');
  });

  it('keeps the provider message when there was no sign-in to drop', async () => {
    // A pasted key with no stored auth: nothing to clear, and rewording would hide HF's reason.
    await expect(adapterFor('huggingface').call({ messages })).rejects.toMatchObject({
      message: 'Invalid username or password.',
    });
    expect(dispatched).not.toContain('apiKeyUpdated');
  });
});
