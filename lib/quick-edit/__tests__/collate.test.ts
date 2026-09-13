import { describe, it, expect } from 'vitest';
import { collate } from '@/lib/quick-edit/collate';
import { buildTally } from '@/lib/quick-edit/tally';
import type { DebugEvent } from '@/lib/stores/types';

let seq = 0;
const ev = (event: string, data: unknown = {}): DebugEvent => ({
  id: `e${++seq}`, timestamp: seq, event, data, count: 1, version: 1,
});
const running = (command: string) =>
  ev('tool_status', { toolCallId: `c${seq + 1}`, toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) });
const of = (...commands: string[]) => buildTally(commands.map(running));

describe('collate', () => {
  it('has nothing to say before any step', () => {
    expect(collate(buildTally([]))).toBeNull();
  });

  it('names the one file a single step touched', () => {
    expect(collate(of('cat /index.html'))).toBe('Read index.html');
  });

  it('folds consecutive steps of one kind into a count of files', () => {
    expect(collate(of('cat /a.html', 'cat /b.html', 'cat /c.html'))).toBe('Read 3 files');
  });

  it('counts a repeat of one file once', () => {
    expect(collate(of('ss /a.css', 'ss /a.css', 'ss /a.css'))).toBe('Edited a.css');
  });

  it('joins clauses in order, with "then" on the second', () => {
    expect(collate(of('search best pizza', 'cat /a.html', 'ss /a.html', 'ss /b.html', 'build')))
      .toBe('Searched the web, then read a.html, edited 2 files, rebuilt the site');
  });

  it('treats a write and an edit as the same activity', () => {
    expect(collate(of('cat > /a.html', 'sed -i s/x/y/ /b.html'))).toBe('Edited 2 files');
  });

  it('collates by kind once there are too many clauses to read in order', () => {
    // Read, edit, read, edit, read: five clauses in order, three kinds.
    expect(collate(of('cat /a.html', 'ss /a.html', 'cat /b.html', 'ss /b.html', 'cat /c.html', 'build')))
      .toBe('Read 3 files, then edited 2 files, rebuilt the site');
  });

  it('falls back to a count when even the kinds are too many', () => {
    const tally = of('cat /a.html', 'ss /a.html', 'grep x /a.html', 'build', 'ls /', 'search x', 'status done', 'rm /old.html');
    expect(collate(tally)).toBe('Ran 8 commands, changed 2 files');
  });

  it('never carries a command into the sentence', () => {
    const tally = of('frobnicate --token sk-live-1234', 'cat ../../etc/passwd');
    expect(collate(tally)).toBe('Ran 1 command, then read a file');
    expect(collate(tally)).not.toContain('sk-live');
  });
});
