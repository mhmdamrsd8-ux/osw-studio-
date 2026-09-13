import type { ActionKind } from '@/lib/agent-activity/parse-command';
import type { Tally, TallyStep } from './tally';

/**
 * A stretch of steps as one sentence.
 *
 * Reads the way a person would sum up what they watched: "Read 3 files, then edited index.html,
 * rebuilt the site". The sentence gets more general as the stretch grows, in three levels, so a
 * long run never becomes a long sentence:
 *
 * 1. consecutive steps of one kind become one clause, in order;
 * 2. past four clauses, all steps of one kind become one clause, ordered by first appearance;
 * 3. past four kinds, the whole stretch is a count of commands and files.
 */

/** The verb families that read as one activity. */
type Family = 'read' | 'change' | 'create' | 'delete' | 'move' | 'copy' | 'search' | 'list' | 'lookup'
  | 'build' | 'evaluate' | 'preview' | 'delegate' | 'image' | 'database' | 'plan' | 'run' | 'other';

const FAMILY: Record<ActionKind, Family> = {
  read: 'read', write: 'change', edit: 'change', create: 'create', delete: 'delete', move: 'move',
  copy: 'copy', search: 'search', list: 'list', lookup: 'lookup', build: 'build', evaluate: 'evaluate',
  preview: 'preview', delegate: 'delegate', image: 'image', database: 'database', plan: 'plan',
  run: 'run', other: 'other',
};

/** Families whose clause names the file, or counts them. */
const FILE_VERBS: Partial<Record<Family, string>> = {
  read: 'Read', change: 'Edited', create: 'Created', delete: 'Deleted', move: 'Moved', copy: 'Copied',
};

/** Families whose clause is one fixed phrase however often they ran. */
const FIXED: Partial<Record<Family, string>> = {
  search: 'Searched the project',
  list: 'Looked through the files',
  lookup: 'Searched the web',
  build: 'Rebuilt the site',
  evaluate: 'Checked its work',
  preview: 'Checked the preview',
  delegate: 'Worked through the request',
  database: 'Worked on the data',
  plan: 'Planned the change',
};

interface Group {
  family: Family;
  /** Distinct files named, in order. */
  files: string[];
  /** Steps that named no file. */
  unnamed: number;
  commands: number;
}

const MAX_CLAUSES = 4;

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function add(group: Group, step: TallyStep): void {
  group.commands += step.steps;
  if (step.path) {
    if (!group.files.includes(step.path)) group.files.push(step.path);
  } else {
    group.unnamed += step.steps;
  }
}

function groupConsecutive(steps: TallyStep[]): Group[] {
  const groups: Group[] = [];
  for (const step of steps) {
    const family = FAMILY[step.kind];
    const last = groups[groups.length - 1];
    if (last && last.family === family) add(last, step);
    else {
      const group: Group = { family, files: [], unnamed: 0, commands: 0 };
      add(group, step);
      groups.push(group);
    }
  }
  return groups;
}

function groupByFamily(steps: TallyStep[]): Group[] {
  const groups: Group[] = [];
  for (const step of steps) {
    const family = FAMILY[step.kind];
    let group = groups.find((g) => g.family === family);
    if (!group) {
      group = { family, files: [], unnamed: 0, commands: 0 };
      groups.push(group);
    }
    add(group, step);
  }
  return groups;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function clause(group: Group): string {
  const fixed = FIXED[group.family];
  if (fixed) return fixed;
  const verb = FILE_VERBS[group.family];
  if (verb) {
    const count = group.files.length + group.unnamed;
    if (group.files.length === 1 && group.unnamed === 0) return `${verb} ${fileName(group.files[0])}`;
    if (count === 1) return `${verb} a file`;
    return `${verb} ${plural(count, 'file', 'files')}`;
  }
  switch (group.family) {
    case 'image': return group.commands === 1 ? 'Made an image' : `Made ${plural(group.commands, 'image', 'images')}`;
    case 'run': return group.commands === 1 ? 'Ran a script' : `Ran ${plural(group.commands, 'script', 'scripts')}`;
    default: return `Ran ${plural(group.commands, 'command', 'commands')}`;
  }
}

function sentence(groups: Group[]): string {
  return groups
    .map((group, i) => {
      const text = clause(group);
      if (i === 0) return text;
      const lowered = text.charAt(0).toLowerCase() + text.slice(1);
      return i === 1 ? `then ${lowered}` : lowered;
    })
    .join(', ');
}

/** One sentence for the steps of a tally, or null when there are none yet. */
export function collate(tally: Tally): string | null {
  if (tally.steps.length === 0) return null;

  const ordered = groupConsecutive(tally.steps);
  if (ordered.length <= MAX_CLAUSES) return sentence(ordered);

  const byFamily = groupByFamily(tally.steps);
  if (byFamily.length <= MAX_CLAUSES) return sentence(byFamily);

  const changed = tally.filesChanged.length;
  const commands = `Ran ${plural(tally.commandCount, 'command', 'commands')}`;
  return changed > 0 ? `${commands}, changed ${plural(changed, 'file', 'files')}` : commands;
}
