'use client';

import React from 'react';
import { Check, Loader2, Redo2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Run, RunContext, RunSegment } from '@/lib/quick-edit/runs';
import { TallyList } from './tally-list';
import { MessageContext } from '@/components/message-context';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { approvalPhrase } from '@/lib/quick-edit/approval-phrase';

/**
 * The conversation as a person who asked for changes reads it: their message, then a card of what
 * came of it, with each stretch of tool activity folded into one sentence, the agent's own words
 * shown as written, and the way back.
 *
 * Replaces the chat panel's transcript in quick edit. It renders runs, never events, so there is
 * nothing here that could show a command or a diff: the redaction happened when the run was built.
 */

export interface SimpleThreadProps {
  runs: Run[];
  generating: boolean;
  isDirty: boolean;
  /** Put the project back to how it was after the given run. */
  onRestore: (checkpointId: string) => void;
  /** Undo the newest run. Null when there is nothing before it to go back to. */
  onUndoLatest: (() => void) | null;
  /** Redo what the last undo took back. Null when nothing has been undone. */
  onRedoLatest: (() => void) | null;
  onSave: () => void;
  /** Answer the gated command a waiting run is stopped on. */
  onAllow: (gateKey: string, capabilityLabel: string) => void;
  onDeny: (capabilityLabel: string) => void;
}

const ACTIVITY_LABEL = { thinking: 'Thinking…', writing: 'Writing…', working: 'Working…' } as const;

/**
 * The person's message, in the shape the transcript gives it.
 *
 * Carries the same context marking as the workspace: the element that was picked, the blocks
 * placed, the files and clips attached. Same component the chat panel uses, read-only here, and
 * it renders nothing when the request came with nothing.
 */
function Request({ text, context }: { text: string; context: RunContext }) {
  const images = context.contentBlocks?.filter((b) => b.type === 'image_url');
  const audio = context.contentBlocks?.filter((b) => b.type === 'input_audio');
  return (
    <div className="text-sm text-foreground bg-primary/10 px-3 py-2 rounded border border-primary/20">
      <div className="font-semibold text-primary mb-1 text-xs">You</div>
      <p className="text-xs leading-relaxed whitespace-pre-wrap">{text}</p>
      <MessageContext
        focusContext={context.focusContext}
        semanticBlocks={context.semanticBlocks}
        fileNames={context.attachedFiles}
        imageBlocks={images?.length ? images : undefined}
        audioBlocks={audio?.length ? audio : undefined}
        readOnly
      />
    </div>
  );
}

function Segment({ segment, live }: { segment: RunSegment; live: boolean }) {
  switch (segment.kind) {
    case 'text':
      return (
        <div className="text-xs leading-relaxed [&_p]:my-0 [&_code]:text-[11px]">
          <MarkdownRenderer content={segment.text} />
        </div>
      );
    case 'steps':
      return <TallyList tally={segment.tally} live={live} />;
  }
}

export function SimpleThread({ runs, generating, isDirty, onRestore, onUndoLatest, onRedoLatest, onSave, onAllow, onDeny }: SimpleThreadProps) {
  if (runs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground p-2">
        Say what you want changed, or pick something on the page first.
      </p>
    );
  }

  const latest = runs[runs.length - 1];

  return (
    <div className="space-y-3">
      {runs.map((run) => {
        const isLatest = run === latest;
        // A request the store has recorded but not yet started answering has no events and no
        // outcome; it reads as working, not as a run that changed nothing.
        const pending = isLatest && !generating && run.segments.length === 0 && run.tally.status === 'idle' && run.tally.summary === null;
        const live = isLatest && (generating || pending);
        const failed = run.tally.status === 'failed';
        const waiting = run.tally.status === 'waiting';
        const lastSegment = run.segments[run.segments.length - 1];
        // The in-flight step already shows under its sentence; the activity line covers the rest.
        const activityLabel = live
          ? run.activity === 'working' && lastSegment?.kind === 'steps' ? null : ACTIVITY_LABEL[run.activity ?? 'working']
          : null;

        return (
          <div key={run.id} className="space-y-2">
            <Request text={run.request} context={run.context} />

            <div
                className={cn('rounded-lg border bg-card px-3 py-2.5 space-y-2', live ? 'border-primary/40' : 'border-border')}
                {...(run.checkpointId ? { 'data-checkpoint-id': run.checkpointId } : {})}
              >
                {run.segments.map((segment, i) => (
                  <Segment key={i} segment={segment} live={live && i === run.segments.length - 1} />
                ))}

                {activityLabel && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {activityLabel}
                  </p>
                )}

                {waiting && run.approval && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 space-y-1.5">
                    <p className="text-xs font-medium">
                      It wants to {approvalPhrase(run.approval.gateKey, run.approval.capabilityLabel)}.
                    </p>
                    <p className="text-[11px] text-muted-foreground">You can undo this afterwards.</p>
                    <div className="flex gap-1.5 pt-0.5">
                      <Button variant="accent" size="xs" onClick={() => onAllow(run.approval!.gateKey, run.approval!.capabilityLabel)} disabled={generating}>Allow</Button>
                      <Button variant="outline" size="xs" onClick={() => onDeny(run.approval!.capabilityLabel)} disabled={generating}>Don't</Button>
                    </div>
                  </div>
                )}

                {!live && (
                  <div className={cn('space-y-1.5', run.segments.length > 0 && 'border-t border-border pt-2')}>
                    {/* A run that simply worked says nothing at the end: the steps above already
                        said it, in more detail than a count of files does. Anything else still
                        reports itself, because nothing else in the card would -- a failure
                        ("Something went wrong") and a run the person stopped ("Stopped."). */}
                    {run.tally.status !== 'done' && run.tally.summary && (
                      <p className={cn('text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}>
                        {run.tally.summary}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {isLatest ? (
                        <>
                          {/* The button flips with the project: once the change is undone, the same
                              spot offers to put it back. */}
                          {onRedoLatest ? (
                            <Button variant="outline" size="xs" onClick={onRedoLatest} disabled={generating}>
                              <Redo2 className="h-3 w-3 mr-1" />
                              Redo this
                            </Button>
                          ) : onUndoLatest && (
                            <Button variant="outline" size="xs" onClick={onUndoLatest} disabled={generating}>
                              <Undo2 className="h-3 w-3 mr-1" />
                              Undo this
                            </Button>
                          )}
                          {isDirty && (
                            <Button variant="accent" size="xs" onClick={onSave} disabled={generating}>
                              <Check className="h-3 w-3 mr-1" />
                              Save
                            </Button>
                          )}
                        </>
                      ) : run.checkpointId && (
                        <Button variant="outline" size="xs" onClick={() => onRestore(run.checkpointId!)} disabled={generating}>
                          <Undo2 className="h-3 w-3 mr-1" />
                          Restore
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
          </div>
        );
      })}
    </div>
  );
}
