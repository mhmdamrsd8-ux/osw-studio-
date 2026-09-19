import { describe, it, expect } from 'vitest';
import { DEFAULT_LOCAL_CONTEXT_LENGTH, resolveLocalContextLength, boundCompactionLimit } from '@/lib/llm/local-context';

describe('resolveLocalContextLength', () => {
  it('uses the setting when it is a positive number', () => {
    expect(resolveLocalContextLength(65536)).toBe(65536);
    expect(resolveLocalContextLength(8192.7)).toBe(8192);
  });

  it('falls back to the default for empty, zero or negative settings', () => {
    expect(resolveLocalContextLength(undefined)).toBe(DEFAULT_LOCAL_CONTEXT_LENGTH);
    expect(resolveLocalContextLength(null)).toBe(DEFAULT_LOCAL_CONTEXT_LENGTH);
    expect(resolveLocalContextLength(0)).toBe(DEFAULT_LOCAL_CONTEXT_LENGTH);
    expect(resolveLocalContextLength(-1)).toBe(DEFAULT_LOCAL_CONTEXT_LENGTH);
  });
});

describe('boundCompactionLimit', () => {
  it('never lets compaction run past the window a local model is loaded with', () => {
    // A discovered Ollama model reports its trained limit (262k); the loaded window is smaller.
    expect(boundCompactionLimit(262144, 32768)).toBe(32768);
  });

  it('keeps a smaller limit the user chose for compaction', () => {
    expect(boundCompactionLimit(20000, 32768)).toBe(20000);
  });

  it('leaves cloud providers alone', () => {
    expect(boundCompactionLimit(128000, undefined)).toBe(128000);
  });
});
