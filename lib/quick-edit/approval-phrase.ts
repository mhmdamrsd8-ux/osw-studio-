/**
 * What a gated capability means, said plainly.
 *
 * The permission system labels a gate for a developer (`rm / rmdir (delete)`); a person who asked for
 * a change needs to know what the agent wants to do, not which command does it. Keyed by gate, with
 * the developer label as the fallback so an unlisted gate still says something true.
 */
const PHRASES: Record<string, string> = {
  rm: 'delete a file',
  mv: 'move a file',
  cp: 'copy a file',
  mkdir: 'create a folder',
  touch: 'create a file',
  'sed:write': 'edit a file',
  ss: 'edit a file',
  'curl:external': 'fetch something from the internet',
  'curl:local': 'call one of the site\'s own functions',
  search: 'search the web',
  'sqlite3:write': 'change the site\'s data',
  'sqlite3:read': 'read the site\'s data',
  python: 'run a script',
  lua: 'run a script',
  'generate-image': 'generate an image',
  build: 'rebuild the site',
  runtime: 'change how the site is built',
};

/** "delete a file", or the gate's own label when nothing plainer is known. */
export function approvalPhrase(gateKey: string, capabilityLabel: string): string {
  return PHRASES[gateKey] ?? capabilityLabel;
}
