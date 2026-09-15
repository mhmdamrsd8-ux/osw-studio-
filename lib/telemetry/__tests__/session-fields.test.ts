import { describe, it, expect } from 'vitest';
import { sessionStartFields } from '../session-fields';
import { shouldShowStopReason } from '../stop-reason';

/**
 * What session_start says about where a session came from. The rule under test is the privacy
 * one: a hostname and three short tags, never a URL.
 */
describe('sessionStartFields', () => {
  it('keeps only the referrer hostname', () => {
    const f = sessionStartFields('https://www.google.com/search?q=osw+studio&sxsrf=abc', '', 'otst-osw-studio.hf.space');
    expect(f).toEqual({ referrer_host: 'www.google.com' });
    expect(JSON.stringify(f)).not.toContain('search');
  });

  it('treats a same-origin referrer as no arrival', () => {
    expect(sessionStartFields('https://otst-osw-studio.hf.space/?project=x', '', 'otst-osw-studio.hf.space')).toEqual({});
  });

  it('reads the three utm tags and nothing else from the query', () => {
    const f = sessionStartFields('', '?utm_source=reddit&utm_medium=post&utm_campaign=launch&utm_content=secret&project=p1', 'h');
    expect(f).toEqual({ utm_source: 'reddit', utm_medium: 'post', utm_campaign: 'launch' });
  });

  it('truncates a long tag', () => {
    const f = sessionStartFields('', '?utm_source=' + 'x'.repeat(200), 'h');
    expect(f.utm_source).toHaveLength(64);
  });

  it('carries nothing for an empty or unparseable referrer', () => {
    expect(sessionStartFields('', '', 'h')).toEqual({});
    expect(sessionStartFields('not a url', '', 'h')).toEqual({});
  });
});

describe('shouldShowStopReason', () => {
  const stop = { projectId: 'p1' };

  it('shows for the stopped project once its run has ended', () => {
    expect(shouldShowStopReason(stop, 'p1', false)).toBe(true);
  });

  it('waits while a run is still in flight', () => {
    expect(shouldShowStopReason(stop, 'p1', true)).toBe(false);
  });

  it('stays hidden in another project\'s panel', () => {
    expect(shouldShowStopReason(stop, 'p2', false)).toBe(false);
  });

  it('shows nothing when no stop is pending', () => {
    expect(shouldShowStopReason(null, 'p1', false)).toBe(false);
  });
});
