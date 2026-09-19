import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OswsToolExecutor } from '../tool-executor';
import type { ToolCall } from '../core/types';

const h = vi.hoisted(() => ({
  toolOutput: '',
}));

vi.mock('../tool-registry', () => ({
  toolRegistry: {
    execute: vi.fn(async () => h.toolOutput),
    getDefinitions: () => [],
  },
}));

function makeExecutor(): OswsToolExecutor {
  return new OswsToolExecutor({
    projectId: 'p1',
    progress: { onEvent: vi.fn() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAgent: () => ({ type: 'orchestrator', hasTool: () => true, tools: ['bash'] } as any),
    chatMode: false,
    abortSignal: new AbortController().signal,
  });
}

function statusCall(cmd: string): ToolCall {
  return {
    id: 'tc1',
    type: 'function',
    function: { name: 'bash', arguments: JSON.stringify({ command: cmd }) },
  };
}

describe('OswsToolExecutor status signal extraction', () => {
  beforeEach(() => {
    h.toolOutput = '';
  });

  it('extracts a complete status from the terse output format', async () => {
    h.toolOutput = 'Status recorded.\nRemaining: none\nComplete: yes';
    const result = await makeExecutor().execute(
      statusCall('status --task "build site" --done "all done" --remaining "none" --complete'),
      { agentType: 'orchestrator', isReadOnly: false },
    );

    expect(result.signals?.statusComplete).toBe(true);
    const statusResult = result.signals?.statusResult as { complete: boolean; remaining: string; hasExplicitFlag: boolean };
    expect(statusResult.complete).toBe(true);
    expect(statusResult.remaining).toBe('none');
    expect(statusResult.hasExplicitFlag).toBe(true);
  });

  it('extracts an incomplete status with remaining work from terse output', async () => {
    h.toolOutput = 'Status recorded.\nRemaining: fix the nav\nComplete: no';
    const result = await makeExecutor().execute(
      statusCall('status --task "t" --done "d" --remaining "fix the nav" --incomplete'),
      { agentType: 'orchestrator', isReadOnly: false },
    );

    expect(result.signals?.statusComplete).toBeUndefined();
    const statusResult = result.signals?.statusResult as { complete: boolean; remaining: string };
    expect(statusResult.complete).toBe(false);
    expect(statusResult.remaining).toBe('fix the nav');
  });

  it('prefers output lines over command parsing when they disagree (escaped quotes)', async () => {
    // The shell parses escaped quotes correctly; the command-regex fallback cannot.
    h.toolOutput = 'Status recorded.\nRemaining: add "About" page\nComplete: no';
    const result = await makeExecutor().execute(
      statusCall('status --task "t" --done "d" --remaining "add \\"About\\" page"'),
      { agentType: 'orchestrator', isReadOnly: false },
    );

    const statusResult = result.signals?.statusResult as { remaining: string };
    expect(statusResult.remaining).toBe('add "About" page');
  });

  it('extracts a complete status when status is chained after another command (build && status)', async () => {
    // The shell ran both; the combined output carries the status lines. The
    // completion signal must still be detected even though the command does
    // not start with "status".
    h.toolOutput = 'Build successful — 0 errors\nStatus recorded.\nRemaining: none\nComplete: yes';
    const result = await makeExecutor().execute(
      statusCall('build && status --task "impl" --done "all" --remaining "none" --complete'),
      { agentType: 'orchestrator', isReadOnly: false },
    );

    expect(result.signals?.statusComplete).toBe(true);
    const statusResult = result.signals?.statusResult as { complete: boolean };
    expect(statusResult.complete).toBe(true);
  });

  it('still extracts from the legacy full output format', async () => {
    h.toolOutput = 'Task: build site\nDone: all done\nRemaining: none\nComplete: yes';
    const result = await makeExecutor().execute(
      statusCall('status --task "build site" --done "all done" --remaining "none" --complete'),
      { agentType: 'orchestrator', isReadOnly: false },
    );

    expect(result.signals?.statusComplete).toBe(true);
  });

  it('does not complete on a chained status when the command failed before it ran', async () => {
    h.toolOutput = 'Error: ss --entity: selector not found in /index.html';
    const executor = makeExecutor();

    const result = await executor.execute(
      statusCall(`ss --entity /index.html << 'EOF'\n<h1>New</h1>\nEOF && build && status --task "t" --done "d" --remaining "none" --complete`),
      { agentType: 'orchestrator', isReadOnly: false },
    );

    expect(result.signals?.statusComplete).toBeUndefined();
    expect(result.signals?.statusResult).toBeUndefined();
  });
});
