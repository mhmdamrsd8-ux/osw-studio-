import type { ShellEnv, ShellResult } from '../types';
import { applyRedirectGuarded, normalizePath, truncate } from '../runtime';

/** `wc` — count lines, words or characters. */
export async function wcCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, args, stdin, ctx, redirect } = env;

  // wc [-l] [-w] [-c] [file ...]  (or stdin via pipe)
  // Default (no flags): show lines, words, chars
  // Multiple files: per-file counts + total line
  const wcFlags = { l: false, w: false, c: false };
  const wcFilePaths: string[] = [];
  let wcAnyFlag = false;

  for (const a of args) {
    if (a && a.startsWith('-')) {
      for (const ch of a.slice(1)) {
        if (ch === 'l') { wcFlags.l = true; wcAnyFlag = true; }
        else if (ch === 'w') { wcFlags.w = true; wcAnyFlag = true; }
        else if (ch === 'c') { wcFlags.c = true; wcAnyFlag = true; }
      }
    } else if (a) {
      wcFilePaths.push(a);
    }
  }

  if (!wcAnyFlag) { wcFlags.l = true; wcFlags.w = true; wcFlags.c = true; }

  const wcCount = (content: string) => ({
    // Count lines, not newlines. Piped stdin arrives without a trailing newline (results are
    // join('\n')), so counting separators alone made every `cmd | wc -l` one short. Files that do
    // end in a newline still count the same as they would under real wc.
    l: content === '' ? 0 : (content.match(/\r?\n/g) || []).length + (/\r?\n$/.test(content) ? 0 : 1),
    w: content.trim() === '' ? 0 : content.trim().split(/\s+/).length,
    c: content.length,
  });

  const wcFormatLine = (counts: { l: number; w: number; c: number }, label?: string) => {
    const parts: string[] = [];
    if (wcFlags.l) parts.push(String(counts.l));
    if (wcFlags.w) parts.push(String(counts.w));
    if (wcFlags.c) parts.push(String(counts.c));
    if (label) parts.push(label);
    return parts.join(' ');
  };

  // Stdin-only (no file args)
  if (wcFilePaths.length === 0) {
    if (stdin === undefined) {
      return { stdout: '', stderr: 'wc: no input file or stdin', exitCode: 2 };
    }
    const wcOutput = wcFormatLine(wcCount(stdin));
    if (redirect) return applyRedirectGuarded(vfs, projectId, wcOutput, redirect, ctx);
    return { stdout: truncate(wcOutput), stderr: '', exitCode: 0 };
  }

  // File args (one or many)
  const wcLines: string[] = [];
  const wcTotals = { l: 0, w: 0, c: 0 };

  for (const fp of wcFilePaths) {
    const wcPath = normalizePath(fp);
    if (!wcPath) continue;
    try {
      const file = await vfs.readFile(projectId, wcPath);
      if (typeof file.content !== 'string') {
        wcLines.push(`wc: ${wcPath}: binary file`);
        continue;
      }
      const counts = wcCount(file.content);
      wcTotals.l += counts.l;
      wcTotals.w += counts.w;
      wcTotals.c += counts.c;
      wcLines.push(wcFormatLine(counts, wcPath));
    } catch (e: any) {
      wcLines.push(`wc: ${wcPath}: ${e?.message || 'file not found'}`);
    }
  }

  // Total line when multiple files
  if (wcFilePaths.length > 1) {
    wcLines.push(wcFormatLine(wcTotals, 'total'));
  }

  const wcOutput = wcLines.join('\n');
  if (redirect) return applyRedirectGuarded(vfs, projectId, wcOutput, redirect, ctx);
  return { stdout: truncate(wcOutput), stderr: '', exitCode: 0 };
}
