import { describe, it, expect, beforeEach } from 'vitest';
import { ServerConfigManager } from '../server-config-manager';
import type { ServerGenerationParams } from '../types';

const baseParams: ServerGenerationParams = {
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'sk-test-key',
  temperature: 0.7,
  maxTokens: 4096,
  reasoningEnabled: false,
  compactionEnabled: true,
  compactionLimit: 80000,
  debugStreamEnabled: false,
  modelPricing: { 'gpt-4o': { prompt: 2.5, completion: 10 } },
  cachedModels: [{ id: 'gpt-4o', name: 'GPT-4o', context_length: 128000 }],
};

describe('ServerConfigManager', () => {
  let config: ServerConfigManager;

  beforeEach(() => {
    config = new ServerConfigManager(baseParams, 'task-123');
  });

  it('returns API key only for the configured provider', () => {
    expect(config.getProviderApiKey('openai')).toBe('sk-test-key');
    expect(config.getProviderApiKey('anthropic')).toBeNull();
  });

  it('returns model only for the configured provider', () => {
    expect(config.getProviderModel('openai')).toBe('gpt-4o');
    expect(config.getProviderModel('anthropic')).toBeNull();
  });

  it('returns cached models only for the configured provider', () => {
    const cached = config.getCachedModels('openai');
    expect(cached).not.toBeNull();
    expect(cached!.models).toHaveLength(1);
    expect(cached!.models[0].id).toBe('gpt-4o');
    expect(config.getCachedModels('anthropic')).toBeNull();
  });

  it('returns model pricing by model id', () => {
    expect(config.getModelPricing('openai', 'gpt-4o')).toEqual({ prompt: 2.5, completion: 10 });
    expect(config.getModelPricing('openai', 'gpt-3.5')).toBeNull();
  });

  it('defaults reasoningEnabled to false when omitted', () => {
    const sparse = new ServerConfigManager({ ...baseParams, reasoningEnabled: undefined } as any, 't');
    expect(sparse.getReasoningEnabled('gpt-4o')).toBe(false);
  });

  it('defaults debugStreamEnabled to false when omitted', () => {
    const sparse = new ServerConfigManager({ ...baseParams, debugStreamEnabled: undefined } as any, 't');
    expect(sparse.getDebugStreamEnabled()).toBe(false);
  });

  it('defaults compactionEnabled to true when omitted', () => {
    const sparse = new ServerConfigManager({ ...baseParams, compactionEnabled: undefined } as any, 't');
    expect(sparse.isCompactionEnabled('openai')).toBe(true);
  });

  it('respects explicit compactionEnabled false', () => {
    const disabled = new ServerConfigManager({ ...baseParams, compactionEnabled: false }, 't');
    expect(disabled.isCompactionEnabled('openai')).toBe(false);
  });

  it('returns context length from cached models', () => {
    expect(config.getModelContextLengthFromCache('openai', 'gpt-4o')).toBe(128000);
    expect(config.getModelContextLengthFromCache('openai', 'gpt-3.5')).toBeUndefined();
  });

  it('tracks session cost across multiple updates', () => {
    config.updateSessionCost({ promptTokens: 100, completionTokens: 50 }, 0.01);
    config.updateSessionCost({ promptTokens: 200, completionTokens: 100 }, 0.02);
    const session = config.getCurrentSession();
    expect(session).not.toBeNull();
    expect(session!.totalCost).toBeCloseTo(0.03);
    expect(session!.requestCount).toBe(2);
  });

  it('reports the local context length the client sent, or nothing', () => {
    expect(config.getLocalContextLength('openai')).toBeUndefined();
    const local = new ServerConfigManager({ ...baseParams, provider: 'ollama', localContextLength: 65536 }, 'task-1');
    expect(local.getLocalContextLength('ollama')).toBe(65536);
  });
});
