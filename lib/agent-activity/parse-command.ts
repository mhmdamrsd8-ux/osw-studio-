/**
 * What one agent action was, read off the command it ran.
 *
 * The agent has a single `bash` tool, so every action is a shell command and "what it did" has to be
 * recovered from that string. This is the one place that recovers it. Surfaces phrase the result
 * themselves: the generation shelf wants a tense and the raw target, the quick-edit dock wants a
 * redacted line, and neither should be re-deriving the vocabulary.
 *
 * Deliberately shallow. It classifies the leading command and finds the file it acted on; it does
 * not understand pipelines, expansion or quoting beyond what those two need.
 */

export type ActionKind =
  | 'write' | 'read' | 'edit'
  | 'list' | 'search'
  | 'create' | 'delete' | 'move' | 'copy'
  | 'evaluate' | 'delegate' | 'lookup' | 'image' | 'database' | 'build' | 'plan'
  | 'preview' | 'run'
  | 'other';

export interface ParsedAction {
  kind: ActionKind;
  /**
   * The absolute project path the command acts on, when it names one. Null for commands that act on
   * no single file, and for a target that is relative or a glob.
   */
  path: string | null;
  /**
   * The raw fragment the target was read from: a path, a search pattern, a command name.
   * Derived from model output, so a surface that must not show tool arguments uses `path` instead.
   */
  detail: string | null;
}

function asPath(detail: string | null): string | null {
  if (!detail) return null;
  if (!detail.startsWith('/') || detail.length < 2) return null;
  if (/[\s*?]/.test(detail)) return null;
  return detail;
}

/**
 * The first absolute path in the command, used when the token the verb points at is not one.
 *
 * `sed -n '1,80p' -e x /index.html` puts its file somewhere the per-verb rules do not look, and a
 * quoted script fragment never starts with a slash, so a scan is both simpler and more reliable
 * than another special case.
 */
function firstAbsolutePath(segment: string): string | null {
  for (const token of segment.split(/\s+/)) {
    const path = asPath(token);
    if (path) return path;
  }
  return null;
}

function action(kind: ActionKind, detail: string | null, segment: string, pathBearing = true): ParsedAction {
  return { kind, path: pathBearing ? asPath(detail) ?? firstAbsolutePath(segment) : null, detail };
}

/**
 * The part of the command that says what the action was.
 *
 * A chain is one action to a reader, and only its first command carries the intent: for
 * `cat /index.html | grep hero` the answer is a read of index.html, not a search for `hero`. The
 * head line is taken first so a heredoc body cannot be mistaken for a continuation, and a bare pipe
 * only splits when it is spaced, which leaves a quoted `"a|b"` search pattern intact.
 *
 * A leading `cd` is skipped rather than classified. The agent habitually writes `cd / && build`,
 * and taking the first segment literally made the action a `cd` — which matches no verb, so the
 * whole command read as "Working" and a run of them read as "Working x10", while the verb that
 * would have named it sat in the next segment.
 */
function leadingSegment(command: string): string {
  const head = command.split('\n')[0];
  const segments = head.split(/(?:&&|\|\|)|\s\|\s|;/).map((part) => part.trim()).filter(Boolean);
  const meaningful = segments.find((part) => !/^cd(\s|$)/.test(part));
  return (meaningful ?? segments[0] ?? '').trim();
}

/**
 * Drop the stderr plumbing before the verb is read.
 *
 * `cat /a.md 2>/dev/null` is a read, but the read branch refuses any command containing `>` so
 * that `cat /a > /b` is not reported as a read of `/a`. The stderr forms carry no such meaning,
 * so they are removed instead of being allowed to defeat the check.
 */
function withoutStderrRedirect(command: string): string {
  return command.replace(/\s2>(?:&1|\S+)/g, '').trim();
}

export function parseCommand(rawCommand: string): ParsedAction | null {
  const trimmed = rawCommand.trim();
  if (!trimmed) return null;
  const cmd = withoutStderrRedirect(leadingSegment(trimmed));
  if (!cmd) return null;

  // A redirection or heredoc is a write however the line started, so both are tested before the
  // verb: `cat /a.html > /b.html` writes b.html and is not a read of a.html. The redirect target
  // has to be an absolute path to count, which keeps a `>` inside a quoted search pattern out.
  const redirect = cmd.match(/(?:^|\s)>>?\s*(\/\S+)/);
  if (redirect) return action('write', redirect[1], cmd);

  if (/<<-?\s*['"]?\w+/.test(cmd)) {
    const match = cmd.match(/^\S+\s+(\/\S+)/);
    return action('write', match?.[1] ?? 'file', cmd);
  }

  if (/^(cat|head|tail|nl|wc)\s+/.test(cmd) && !/>/.test(cmd)) {
    const parts = cmd.split(/\s+/);
    return action('read', parts[parts.length - 1], cmd);
  }

  if (/^(sed|ss)\s+/.test(cmd)) {
    const match = cmd.match(/\s(\S+)\s*$/);
    return action('edit', match?.[1] ?? 'file', cmd);
  }

  if (/^(echo|touch)\s+/.test(cmd)) {
    const match = cmd.match(/\s(\/\S+)\s*$/);
    return action('edit', match?.[1] ?? 'file', cmd);
  }

  if (/^(ls|tree|find)\b/.test(cmd)) return action('list', cmd.split(/\s+/)[1] ?? '/', cmd);

  if (/^(grep|rg)\s+/.test(cmd)) {
    return action('search', cmd.split(/\s+/).slice(1, 3).join(' '), cmd, false);
  }

  if (/^(mkdir|propose-create)\s+/.test(cmd)) {
    const target = cmd.replace(/^\S+\s+(-p\s+)?/, '').split(/\s+/)[0];
    return action('create', target, cmd);
  }

  if (/^(rm|rmdir)\s+/.test(cmd)) return action('delete', cmd.split(/\s+/).pop() ?? null, cmd);
  if (/^mv\s+/.test(cmd)) return action('move', cmd.split(/\s+/).pop() ?? null, cmd);
  if (/^cp\s+/.test(cmd)) return action('copy', cmd.split(/\s+/).pop() ?? null, cmd);

  if (/^status\b/.test(cmd)) return action('evaluate', 'progress', cmd, false);

  // `delegate` is the pre-v1.70.0 spelling of `agent` and is still accepted by the coordinator.
  if (/^(agent|delegate)\s+/.test(cmd)) {
    return action('delegate', cmd.split(/\s+/)[1] ?? 'agent', cmd, false);
  }

  if (/^(search|curl)\s+/.test(cmd)) return action('lookup', cmd.split(/\s+/)[0], cmd, false);
  if (/^generate-image\b/.test(cmd)) return action('image', 'generate-image', cmd, false);
  if (/^sqlite3\b/.test(cmd)) return action('database', 'sqlite3', cmd, false);
  if (/^(runtime|build)\b/.test(cmd)) return action('build', cmd.split(/\s+/)[0], cmd, false);
  if (/^preview\b/.test(cmd)) return action('preview', cmd.split(/\s+/)[1] ?? null, cmd);
  // `python3` as well as `python`: \b does not match between `n` and `3`.
  if (/^(python\d*|lua\d*)\b/.test(cmd)) return action('run', cmd.split(/\s+/)[0], cmd, false);
  if (/^(spec|brief|ask)\b/.test(cmd)) return action('plan', cmd.split(/\s+/)[0], cmd, false);

  return action('other', cmd.split(/\s+/)[0], cmd, false);
}

/**
 * The action behind a tool call, from the arguments the executor reported.
 *
 * Arguments arrive as the JSON string the model produced, so a partial or malformed value is
 * expected rather than exceptional and yields no action at all.
 */
export function parseToolArgs(argsJson: unknown): ParsedAction | null {
  if (typeof argsJson !== 'string') return null;
  try {
    const args = JSON.parse(argsJson);
    const command = args?.command ?? args?.cmd;
    return typeof command === 'string' ? parseCommand(command) : null;
  } catch {
    return null;
  }
}
