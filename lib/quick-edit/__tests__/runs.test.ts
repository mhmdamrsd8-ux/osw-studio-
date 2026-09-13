import { describe, it, expect } from 'vitest';
import { splitRuns } from '@/lib/quick-edit/runs';
import type { DebugEvent } from '@/lib/stores/types';

let seq = 0;
const ev = (event: string, data: unknown = {}): DebugEvent => ({
  id: `e${++seq}`, timestamp: seq, event, data, count: 1, version: 1,
});
const user = (content: unknown) => ev('conversation_message', { message: { role: 'user', content } });
const assistant = (content: unknown) => ev('conversation_message', { message: { role: 'assistant', content } });
const running = (command: string) =>
  ev('tool_status', { toolCallId: `c${seq + 1}`, toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) });

describe('splitRuns', () => {
  it('has no runs before anyone asked for anything', () => {
    expect(splitRuns([ev('project_context'), running('ls /')])).toEqual([]);
  });

  it('cuts one run per request, in order', () => {
    const runs = splitRuns([user('Make it blue'), running('ss /a.css'), user('Now green'), running('ss /a.css')]);
    expect(runs.map((r) => r.request)).toEqual(['Make it blue', 'Now green']);
    expect(runs.map((r) => r.tally.commandCount)).toEqual([1, 1]);
  });

  it('keys each run by its request event', () => {
    const first = user('One');
    expect(splitRuns([first, running('ls /')])[0].id).toBe(first.id);
  });

  it('reads a request written as content blocks, ignoring the images in it', () => {
    const run = splitRuns([user([{ type: 'text', text: 'Match this' }, { type: 'image_url', image_url: { url: 'data:...' } }])])[0];
    expect(run.request).toBe('Match this');
  });

  it('keeps what happened in order: prose, then a folded stretch of steps, then prose', () => {
    const run = splitRuns([
      user('Fix it'),
      assistant(''),
      assistant('Working on it.'),
      running('cat /a.css'),
      running('ss /a.css'),
      assistant('Done. The header is blue now.'),
    ])[0];
    expect(run.segments.map((s) => s.kind)).toEqual(['text', 'steps', 'text']);
    expect(run.segments[0]).toEqual({ kind: 'text', text: 'Working on it.' });
    expect((run.segments[1] as { tally: { commandCount: number } }).tally.commandCount).toBe(2);
    expect(run.segments[2]).toEqual({ kind: 'text', text: 'Done. The header is blue now.' });
  });

  it('keeps no reasoning: the message\'s prose is the segment, its reasoning is not', () => {
    const run = splitRuns([
      user('Fix it'),
      ev('conversation_message', { message: { role: 'assistant', content: 'I will change the colour.', reasoning_details: [{ text: 'The user wants blue.' }] } }),
    ])[0];
    expect(run.segments).toEqual([{ kind: 'text', text: 'I will change the colour.' }]);
    expect(JSON.stringify(run)).not.toContain('The user wants blue');
  });

  it('reports what the agent is doing right now from the last event', () => {
    expect(splitRuns([user('Fix it'), ev('reasoning_start'), ev('reasoning_delta', { text: 'x' })])[0].activity).toBe('thinking');
    expect(splitRuns([user('Fix it'), ev('assistant_delta', { text: 'I' })])[0].activity).toBe('writing');
    expect(splitRuns([user('Fix it'), running('cat /a.html')])[0].activity).toBe('working');
    expect(splitRuns([user('Fix it'), ev('reasoning_delta', { text: 'x' }), assistant('Done.')])[0].activity).toBeNull();
    expect(splitRuns([user('Fix it')])[0].activity).toBeNull();
  });

  it('closes a stretch of steps when the run ends without the agent speaking', () => {
    const run = splitRuns([user('Fix it'), running('ss /a.css')])[0];
    expect(run.segments.map((s) => s.kind)).toEqual(['steps']);
  });

  it('has no segments when the agent did nothing and said nothing', () => {
    expect(splitRuns([user('Fix it')])[0].segments).toEqual([]);
  });

  it('takes the checkpoint the run finished on', () => {
    const run = splitRuns([user('Fix it'), ev('checkpoint_created', { checkpointId: 'cp_1' }), ev('task_complete')])[0];
    expect(run.checkpointId).toBe('cp_1');
  });

  it('does not start a run at a message the harness sent as the user', () => {
    const runs = splitRuns([
      user('Fix it'),
      running('ss /a.css'),
      user('Before finishing, run the status command: status --task "…"'),
      running('status done'),
      user('<automated_reminder>keep going</automated_reminder>'),
    ]);
    expect(runs.map((r) => r.request)).toEqual(['Fix it']);
    expect(runs[0].tally.commandCount).toBe(2);
  });

  it('does not start a run at a synthetic error, which is also sent as the user', () => {
    const runs = splitRuns([
      user('Fix it'),
      ev('conversation_message', { message: { role: 'user', content: 'Error: boom', ui_metadata: { isSyntheticError: true } } }),
    ]);
    expect(runs).toHaveLength(1);
  });

  it('shows the words the person typed, not the context the client wrapped around them', () => {
    const run = splitRuns([
      ev('conversation_message', { message: { role: 'user', content: 'Fix it\n\n- /.skills/x.md: use this', ui_metadata: { displayContent: 'Fix it' } } }),
    ])[0];
    expect(run.request).toBe('Fix it');
  });

  it('carries the gated command a waiting run is stopped on, and only while it waits', () => {
    const waiting = splitRuns([
      user('Remove the old page'),
      ev('approval_required', { gateKey: 'rm', command: 'rm /old.html', capabilityLabel: 'rm / rmdir (delete)' }),
    ])[0];
    expect(waiting.tally.status).toBe('waiting');
    expect(waiting.approval).toEqual({ gateKey: 'rm', capabilityLabel: 'rm / rmdir (delete)' });
    expect(JSON.stringify(waiting)).not.toContain('rm /old.html');

    const resumed = splitRuns([
      user('Remove the old page'),
      ev('approval_required', { gateKey: 'rm', capabilityLabel: 'rm / rmdir (delete)' }),
      ev('task_complete'),
    ])[0];
    expect(resumed.approval).toBeNull();
  });

  it('carries the request\'s context marking, as the workspace shows it', () => {
    const focusContext = { domPath: 'body>h1', snippet: '<h1>Hi</h1>' };
    const semanticBlocks = [{ name: 'Hero', domPath: 'body>section', position: 'after', description: 'A hero' }];
    const attachedFiles = [{ name: 'brief.md' }];
    const runs = splitRuns([
      ev('conversation_message', {
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Make it blue' }, { type: 'image_url', image_url: { url: 'data:,' } }],
          ui_metadata: { focusContext, semanticBlocks, attachedFiles },
        },
      }),
      running('ss /a.css'),
    ]);
    expect(runs[0].context.focusContext).toEqual(focusContext);
    expect(runs[0].context.semanticBlocks).toEqual(semanticBlocks);
    expect(runs[0].context.attachedFiles).toEqual(attachedFiles);
    expect(runs[0].context.contentBlocks).toHaveLength(1);
  });

  it('gives a request that came with nothing an empty context', () => {
    expect(splitRuns([user('Just words'), running('ls /')])[0].context).toEqual({});
  });

  it('does not let one run\'s events leak into the next', () => {
    const runs = splitRuns([
      user('A'), ev('checkpoint_created', { checkpointId: 'cp_a' }), assistant('Did A.'),
      user('B'), running('cat /x.html'),
    ]);
    expect(runs[1].checkpointId).toBeNull();
    expect(runs[1].segments.map((s) => s.kind)).toEqual(['steps']);
    expect(runs[0].tally.commandCount).toBe(0);
  });
});
