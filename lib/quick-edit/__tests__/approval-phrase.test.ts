import { describe, it, expect } from 'vitest';
import { approvalPhrase } from '@/lib/quick-edit/approval-phrase';

describe('approvalPhrase', () => {
  it('says what the agent wants to do, not which command does it', () => {
    expect(approvalPhrase('rm', 'rm / rmdir (delete)')).toBe('delete a file');
    expect(approvalPhrase('curl:external', 'curl')).toBe('fetch something from the internet');
  });

  it('falls back to the developer label for a gate it has no words for', () => {
    expect(approvalPhrase('something-new', 'something-new (label)')).toBe('something-new (label)');
  });
});
