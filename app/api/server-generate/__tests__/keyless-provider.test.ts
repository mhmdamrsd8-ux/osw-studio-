import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * A local provider has no API key. The start route used to list `apiKey` among its
 * required fields, so a self-hosted instance could never start an Ollama task: the
 * client sent an empty key and got "Missing required fields". The key is required
 * exactly when the named provider requires one.
 */

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('@/lib/server-generate/singleton', () => ({
  taskManager: {
    initialize: vi.fn(),
    updateTask: vi.fn(),
    getTask: () => ({ id: 'task-1' }),
    createTask: vi.fn(() => 'task-1'),
  },
  eventBus: {},
}));
vi.mock('@/lib/server-generate/server-orchestrator-runner', () => ({
  runServerGeneration: vi.fn(async () => undefined),
}));

function makeReq(body: unknown): NextRequest {
  return {
    cookies: { get: () => undefined },
    headers: new Headers(),
    nextUrl: new URL('http://localhost/api/server-generate'),
    signal: new AbortController().signal,
    json: async () => body,
  } as unknown as NextRequest;
}

const base = { projectId: 'p1', prompt: 'change the heading', model: 'qwen3:4b' };

beforeEach(() => {
  // Desktop mode passes auth without a cookie; only the body validation is under test.
  process.env.OSW_DESKTOP = 'true';
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.OSW_DESKTOP;
});

describe('POST /api/server-generate key requirement', () => {
  it('starts a task for a local provider with no key', async () => {
    const { POST } = await import('../route');
    const { taskManager } = await import('@/lib/server-generate/singleton');

    const res = await POST(makeReq({ ...base, apiKey: '', providerConfig: { provider: 'ollama' } }));

    expect(res.status).toBe(200);
    expect(vi.mocked(taskManager.createTask)).toHaveBeenCalledWith('p1', expect.any(String), '', undefined);
  });

  it('refuses a cloud provider with no key', async () => {
    const { POST } = await import('../route');

    const res = await POST(makeReq({ ...base, apiKey: '', providerConfig: { provider: 'openrouter' } }));

    // Every other field is present, so the only 400 left is the key check.
    expect(res.status).toBe(400);
  });

  it('refuses a missing key when no provider is named', async () => {
    const { POST } = await import('../route');

    const res = await POST(makeReq({ ...base, apiKey: '' }));

    expect(res.status).toBe(400);
  });
});
