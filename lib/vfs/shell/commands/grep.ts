import type { ShellEnv, ShellResult } from '../types';
import { applyRedirectGuarded, normalizePath, truncate } from '../runtime';

/** `grep` — search file contents. */
export async function grepCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, args, stdin, ctx, redirect } = env;

          // Supported: grep [-n] [-i] [-o] [-F] [-P] [-A num] [-B num] [-C num] pattern path  (always recursive)
          const flags: Record<string, any> = { n: false, i: false, o: false, F: false, c: false, l: false, C: 0, A: 0, B: 0 };
          const unknownFlags: string[] = [];
          const fargs: string[] = [];
          for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
              const flagStr = a.slice(1);
              for (let j = 0; j < flagStr.length; j++) {
                const ch = flagStr[j];
                if (ch === 'n') flags.n = true;
                else if (ch === 'i') flags.i = true;
                else if (ch === 'o') flags.o = true;
                else if (ch === 'F') flags.F = true;
                else if (ch === 'P') {} // no-op — JS regex covers most PCRE patterns
                else if (ch === 'c') flags.c = true;
                else if (ch === 'l') flags.l = true;
                else if (ch === 'C') { flags.C = parseInt(args[++i]) || 2; break; }
                else if (ch === 'A') { flags.A = parseInt(args[++i]) || 2; break; }
                else if (ch === 'B') { flags.B = parseInt(args[++i]) || 2; break; }
                // An unsupported flag used to be dropped silently, so `grep -c` printed matching
                // lines and read as a count of one. Fail loudly instead — a wrong-shaped result
                // is worse than no result.
                else unknownFlags.push(`-${ch}`);
              }
            } else {
              fargs.push(a);
            }
          }
          if (unknownFlags.length > 0) {
            return {
              stdout: '',
              stderr: `grep: unsupported flag${unknownFlags.length > 1 ? 's' : ''}: ${unknownFlags.join(', ')}\n\n  Supported: -n -i -o -F -P -c -l -A NUM -B NUM -C NUM\n  Run grep with no pattern for full usage.`,
              exitCode: 2
            };
          }

          const pattern = fargs[0];
          const path = normalizePath(fargs[1]) || '/';
          if (!pattern) {
            return {
              stdout: '',
              stderr: `grep: missing pattern

  Usage: grep [FLAGS] PATTERN [PATH]

  Supported flags:
    -n      Show line numbers
    -i      Case insensitive search
    -o      Print only the matched parts of each line (one per line)
    -F      Treat pattern as literal string (not regex)
    -P      Perl-compatible regex (accepted, JS regex used)
    -c      Print the count of matching lines instead of the lines
    -l      Print only the paths of files that contain a match
    -A NUM  Show NUM lines after each match
    -B NUM  Show NUM lines before each match
    -C NUM  Show NUM lines of context (before and after)

  Examples:
    {"cmd": ["grep", "searchterm", "/path"]}
    {"cmd": ["grep", "-n", "pattern", "/file.txt"]}
    {"cmd": ["grep", "-i", "TODO", "/"]}
    {"cmd": ["grep", "-o", "href=\"[^\"]*\"", "/index.html"]}
    {"cmd": ["grep", "-F", "exact.string", "/src"]}
    {"cmd": ["grep", "-A", "3", "pattern", "/file.txt"]}
    {"cmd": ["grep", "-C", "5", "function", "/src"]}

  Note: grep always searches recursively. rg (ripgrep) is also available.`,
              exitCode: 2
            };
          }

          // Create regex - escape special chars if -F flag is used
          let regex: RegExp;
          if (flags.F) {
            const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(escaped, flags.i ? 'i' : '');
          } else {
            regex = new RegExp(pattern, flags.i ? 'i' : '');
          }

          const outLines: string[] = [];
          const hasContext = flags.C > 0 || flags.A > 0 || flags.B > 0;
          const globalRegex = flags.o ? new RegExp(regex.source, regex.flags + 'g') : null;

          // -c / -l count or name whole matching lines, so they ignore -o and the context flags
          // rather than post-processing the formatted output those produce.
          if (flags.c || flags.l) {
            const countLines = (content: string) =>
              content.split(/\r?\n/).reduce((n, line) => (regex.test(line) ? n + 1 : n), 0);

            const lines: string[] = [];
            if (!fargs[1] && stdin !== undefined) {
              const n = countLines(stdin);
              if (flags.l) { if (n > 0) lines.push('(standard input)'); }
              else lines.push(String(n));
            } else {
              const entries = await vfs.getAllFilesAndDirectories(projectId, { includeTransient: true });
              const dirPrefix = path === '/' ? '/' : (path.endsWith('/') ? path : path + '/');
              const counts: Array<{ path: string; n: number }> = [];
              for (const entry of entries) {
                // Both members carry `type`, so the literal check narrows the union on its own.
                if (entry.type === 'directory') continue;
                if (!entry.path.startsWith(dirPrefix) && entry.path !== path) continue;
                if (typeof entry.content !== 'string') continue;
                counts.push({ path: entry.path, n: countLines(entry.content) });
              }

              // A path naming one file reports a bare count, as grep does — including the zero.
              // Suppressing zeroes here is what made `grep -c missing /file` answer with silence.
              const single = counts.length === 1 && counts[0].path === path;
              if (flags.l) {
                for (const c of counts) if (c.n > 0) lines.push(c.path);
              } else if (single) {
                lines.push(String(counts[0].n));
              } else {
                for (const c of counts) if (c.n > 0) lines.push(`${c.path}:${c.n}`);
              }
            }

            const result: ShellResult = {
              stdout: truncate(lines.join('\n')),
              stderr: '',
              exitCode: 0
            };
            if (redirect) return applyRedirectGuarded(vfs, projectId, result.stdout, redirect, ctx);
            return result;
          }

          // If no file path provided and stdin is available, search stdin
          if (!fargs[1] && stdin !== undefined) {
            const stdinLines = stdin.split(/\r?\n/);
            if (flags.o) {
              for (let i = 0; i < stdinLines.length; i++) {
                const matches = [...stdinLines[i].matchAll(globalRegex!)];
                for (const m of matches) {
                  outLines.push(flags.n ? `${i + 1}:${m[0]}` : m[0]);
                }
              }
            } else if (hasContext) {
              const matchedStdinLines = new Set<number>();
              for (let i = 0; i < stdinLines.length; i++) {
                if (regex.test(stdinLines[i])) matchedStdinLines.add(i);
              }
              if (matchedStdinLines.size > 0) {
                const contextStdinLines = new Set<number>();
                const beforeCtx = flags.C || flags.B;
                const afterCtx = flags.C || flags.A;
                for (const ln of matchedStdinLines) {
                  for (let j = Math.max(0, ln - beforeCtx); j <= Math.min(stdinLines.length - 1, ln + afterCtx); j++) {
                    contextStdinLines.add(j);
                  }
                }
                for (const ln of Array.from(contextStdinLines).sort((a, b) => a - b)) {
                  outLines.push(flags.n ? `${ln + 1}:${stdinLines[ln]}` : stdinLines[ln]);
                }
              }
            } else {
              for (let i = 0; i < stdinLines.length; i++) {
                if (regex.test(stdinLines[i])) {
                  outLines.push(flags.n ? `${i + 1}:${stdinLines[i]}` : stdinLines[i]);
                }
              }
            }
          } else {
            const entries = await vfs.getAllFilesAndDirectories(projectId, { includeTransient: true });
            const dirPrefix = path === '/' ? '/' : (path.endsWith('/') ? path : path + '/');
            for (const entry of entries) {
              if (entry.type === 'directory') continue;
              if (!entry.path.startsWith(dirPrefix) && entry.path !== path) continue;
              if (typeof entry.content !== 'string') continue;
              const lines = entry.content.split(/\r?\n/);

              if (flags.o) {
                for (let i = 0; i < lines.length; i++) {
                  const matches = [...lines[i].matchAll(globalRegex!)];
                  for (const m of matches) {
                    outLines.push(`${entry.path}${flags.n ? ':' + (i + 1) : ''}:${m[0]}`);
                  }
                }
              } else if (hasContext) {
                const matchedLines = new Set<number>();
                for (let i = 0; i < lines.length; i++) {
                  if (regex.test(lines[i])) matchedLines.add(i);
                }
                if (matchedLines.size === 0) continue;

                const contextLines = new Set<number>();
                const beforeContext = flags.C || flags.B;
                const afterContext = flags.C || flags.A;
                for (const lineNum of matchedLines) {
                  for (let j = Math.max(0, lineNum - beforeContext); j <= Math.min(lines.length - 1, lineNum + afterContext); j++) {
                    contextLines.add(j);
                  }
                }

                const sortedLines = Array.from(contextLines).sort((a, b) => a - b);
                if (outLines.length > 0) outLines.push(''); // separator between files
                for (const lineNum of sortedLines) {
                  outLines.push(`${entry.path}${flags.n ? ':' + (lineNum + 1) : ''}:${lines[lineNum]}`);
                }
              } else {
                for (let i = 0; i < lines.length; i++) {
                  if (regex.test(lines[i])) {
                    outLines.push(`${entry.path}${flags.n ? ':' + (i + 1) : ''}:${lines[i]}`);
                  }
                }
              }
            }
          }

          const output = outLines.join('\n');
          if (outLines.length === 0) {
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          const grepResult: ShellResult = { stdout: truncate(output), stderr: '', exitCode: 0 };
          if (redirect) return applyRedirectGuarded(vfs, projectId, grepResult.stdout, redirect, ctx);
          return grepResult;
}
