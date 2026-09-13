import type { DebugEvent } from '@/lib/stores/types';
import type { ContentBlock } from '@/lib/llm/types';
import { buildTally, type Tally } from './tally';
import { isInjectedUserMessage } from '@/components/chat-panel/event-processor';

/**
 * The event stream cut into runs: one per request a person made.
 *
 * The chat panel groups events by model iteration, which is the right grain for a developer reading
 * a transcript and the wrong one for someone who asked for a change and wants to know what came of
 * it. A run starts at a user message and ends at the next; everything between is what the agent did
 * about it, folded into a tally.
 */

/**
 * One stretch of a run, in the order it happened.
 *
 * `text` is the model's prose, addressed to the person and shown as written. `steps` is a stretch of
 * tool activity folded into a tally. Reasoning is not kept: it shows as a passing indicator while it
 * happens and is gone once it is done. Prose comes from the completed assistant message, not the
 * streamed deltas, so it appears when its message lands rather than character by character.
 */
export type RunSegment =
  | { kind: 'text'; text: string }
  | { kind: 'steps'; tally: Tally };

/**
 * What the agent is doing at this moment, read off the last event: reasoning, writing a message,
 * or running commands. Meaningful only while the run is live; it says nothing about a finished run.
 */
type RunActivity = 'thinking' | 'writing' | 'working' | null;

/**
 * What was attached to a request besides its words: the element picked on the page, the blocks
 * placed, the files and clips brought along. Read from the same `ui_metadata` the chat panel
 * reads, so a request is marked up here exactly as it is in the workspace.
 */
export interface RunContext {
  focusContext?: { domPath: string; snippet: string };
  semanticBlocks?: Array<{ name: string; domPath: string; position: string; description: string }>;
  attachedFiles?: Array<{ name: string }>;
  /** Image and audio blocks, as they appear in the message content. */
  contentBlocks?: ContentBlock[];
}

export interface Run {
  /** The user message's event id, stable for keying a list. */
  id: string;
  /** The person's own words. */
  request: string;
  /** What came with them. */
  context: RunContext;
  /** What happened, in order. */
  segments: RunSegment[];
  activity: RunActivity;
  /** The checkpoint written when this run finished, if it finished. */
  checkpointId: string | null;
  /** The gated command a waiting run is stopped on. Null unless the run is waiting. */
  approval: { gateKey: string; capabilityLabel: string } | null;
  tally: Tally;
}

/** The text of a message whose content may be a string or content blocks. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('\n');
}

interface Message {
  role?: unknown;
  content?: unknown;
  ui_metadata?: {
    displayContent?: unknown;
    isSyntheticError?: unknown;
    focusContext?: RunContext['focusContext'];
    semanticBlocks?: RunContext['semanticBlocks'];
    attachedFiles?: RunContext['attachedFiles'];
  };
}

/** The context marking of a request, or an empty one when it came with nothing. */
function requestContext(message: Message): RunContext {
  const meta = message.ui_metadata;
  const content = meta?.displayContent ?? message.content;
  const blocks = Array.isArray(content)
    ? content.filter((b): b is ContentBlock =>
        typeof b === 'object' && b !== null
        && ((b as { type?: unknown }).type === 'image_url' || (b as { type?: unknown }).type === 'input_audio'))
    : [];
  return {
    ...(meta?.focusContext ? { focusContext: meta.focusContext } : {}),
    ...(meta?.semanticBlocks?.length ? { semanticBlocks: meta.semanticBlocks } : {}),
    ...(meta?.attachedFiles?.length ? { attachedFiles: meta.attachedFiles } : {}),
    ...(blocks.length ? { contentBlocks: blocks } : {}),
  };
}

function messageOf(event: DebugEvent): Message | null {
  if (event.event !== 'conversation_message') return null;
  const message = (event.data as { message?: unknown } | undefined)?.message;
  return typeof message === 'object' && message !== null ? message as Message : null;
}

/**
 * Whether this user message is one the person sent.
 *
 * The harness also speaks as the user, to nudge, remind or report an error, and the client keeps
 * what the person typed apart from what was added around it. A run starts only at the former.
 */
function isPersonsRequest(message: Message): boolean {
  if (message.role !== 'user') return false;
  if (message.ui_metadata?.isSyntheticError === true) return false;
  return !isInjectedUserMessage(message.content);
}

/** The person's own words: the display copy when the client kept one, else the content. */
function requestText(message: Message): string {
  return messageText(message.ui_metadata?.displayContent ?? message.content).trim();
}

/** What the last telling event says the agent is doing. */
function activityOf(events: DebugEvent[]): RunActivity {
  for (let i = events.length - 1; i >= 0; i--) {
    switch (events[i].event) {
      case 'reasoning_start':
      case 'reasoning_delta':
        return 'thinking';
      case 'assistant_delta':
        return 'writing';
      case 'toolCalls':
      case 'tool_status':
      case 'tool_param_delta':
        return 'working';
      case 'conversation_message':
      case 'reasoning_complete':
      case 'task_complete':
      case 'stopped':
      case 'error':
        return null;
    }
  }
  return null;
}

function finish(start: DebugEvent, events: DebugEvent[]): Run {
  let checkpointId: string | null = null;
  let approval: Run['approval'] = null;
  const segments: RunSegment[] = [];
  // Tool activity accumulates until the model speaks, then folds into one steps segment.
  let stretch: DebugEvent[] = [];
  const flush = () => {
    if (stretch.length === 0) return;
    const tally = buildTally(stretch);
    if (tally.steps.length > 0) segments.push({ kind: 'steps', tally });
    stretch = [];
  };

  for (const event of events) {
    if (event.event === 'approval_required') {
      const data = (event.data ?? {}) as { gateKey?: unknown; capabilityLabel?: unknown };
      if (typeof data.gateKey === 'string') {
        approval = { gateKey: data.gateKey, capabilityLabel: typeof data.capabilityLabel === 'string' ? data.capabilityLabel : data.gateKey };
      }
    }
    if (event.event === 'checkpoint_created') {
      const id = (event.data as { checkpointId?: unknown } | undefined)?.checkpointId;
      if (typeof id === 'string') checkpointId = id;
    }
    const message = messageOf(event);
    if (message?.role === 'assistant') {
      const text = messageText(message.content).trim();
      if (text !== '') {
        flush();
        segments.push({ kind: 'text', text });
      }
      continue;
    }
    stretch.push(event);
  }
  flush();

  const tally = buildTally(events);
  return {
    id: start.id,
    request: requestText(messageOf(start)!),
    context: requestContext(messageOf(start)!),
    segments,
    activity: activityOf(events),
    checkpointId,
    approval: tally.status === 'waiting' ? approval : null,
    tally,
  };
}

export function splitRuns(events: DebugEvent[]): Run[] {
  const runs: Run[] = [];
  let start: DebugEvent | null = null;
  let current: DebugEvent[] = [];

  for (const event of events) {
    const message = messageOf(event);
    if (message && isPersonsRequest(message)) {
      if (start) runs.push(finish(start, current));
      start = event;
      current = [];
      continue;
    }
    // Anything before the first request has no one to answer to and is dropped.
    if (start) current.push(event);
  }
  if (start) runs.push(finish(start, current));
  return runs;
}
