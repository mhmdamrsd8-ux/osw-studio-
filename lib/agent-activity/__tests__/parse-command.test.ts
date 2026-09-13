import { describe, it, expect } from 'vitest';
import { parseCommand, parseToolArgs } from '@/lib/agent-activity/parse-command';

describe('parseCommand', () => {
  it('has nothing to say about an empty command', () => {
    expect(parseCommand('   ')).toBeNull();
  });

  it('looks past a leading cd, which is how the agent writes most commands', () => {
    expect(parseCommand('cd / && build')?.kind).toBe('build');
    expect(parseCommand('cd / && status --task "x" --complete')?.kind).toBe('evaluate');
    expect(parseCommand('cd /tmp && ls')?.kind).toBe('list');
    expect(parseCommand('cd / && cat /index.html')).toMatchObject({ kind: 'read', path: '/index.html' });
  });

  it.each([
    ['cat > /index.html', 'write', '/index.html'],
    ['ss /styles.css << \'EOF\'', 'write', '/styles.css'],
    ['cat /about.html', 'read', '/about.html'],
    ['head -n 20 /pages/blog.html', 'read', '/pages/blog.html'],
    ['sed -i s/a/b/ /index.html', 'edit', '/index.html'],
    ['mkdir -p /assets/img', 'create', '/assets/img'],
    ['rm /old.html', 'delete', '/old.html'],
    ['mv /a.html /b.html', 'move', '/b.html'],
    ['cp /a.html /b.html', 'copy', '/b.html'],
  ])('reads %s as %s on %s', (command, kind, path) => {
    expect(parseCommand(command)).toMatchObject({ kind, path });
  });

  it.each([
    ['ls /', 'list'],
    ['grep -n hero /index.html', 'search'],
    ['status done', 'evaluate'],
    ['agent explore "where is the nav"', 'delegate'],
    ['search best pizza', 'lookup'],
    ['generate-image a cat', 'image'],
    ['sqlite3 SELECT 1', 'database'],
    ['runtime restart', 'build'],
    ['spec write', 'plan'],
    ['someunknowncmd --flag', 'other'],
  ])('reads %s as %s and claims no file', (command, kind) => {
    expect(parseCommand(command)).toMatchObject({ kind, path: null });
  });

  it('treats a redirection as a write even when the line opens with a reading command', () => {
    // Precedence matters: `cat > /x` shares its verb with the read case and is not one.
    expect(parseCommand('cat > /notes.html')?.kind).toBe('write');
  });

  it('still accepts delegate, the pre-v1.70.0 spelling of agent', () => {
    expect(parseCommand('delegate task "do the thing"')).toMatchObject({ kind: 'delegate', detail: 'task' });
  });

  it('reads a chain as its first command, not its last', () => {
    expect(parseCommand('cat /index.html | grep hero')).toMatchObject({ kind: 'read', path: '/index.html' });
    expect(parseCommand('ss /a.css << \'EOF\' && status done')).toMatchObject({ kind: 'write', path: '/a.css' });
  });

  it('leaves a quoted pipe inside a search pattern alone', () => {
    expect(parseCommand('grep -n "hero|banner" /index.html')?.detail).toContain('hero|banner');
  });

  it('finds the file when the verb rule points somewhere that is not one', () => {
    // Real runs put the file before the flags often enough to matter; without the scan this reads
    // as an edit to no particular file.
    expect(parseCommand('sed -i /index.html -e s/a/b/')).toMatchObject({ kind: 'edit', path: '/index.html' });
  });

  it('refuses a relative target as a path, keeping it only as detail', () => {
    expect(parseCommand('cat notes.txt')).toMatchObject({ kind: 'read', path: null, detail: 'notes.txt' });
  });

  it('refuses a glob as a path', () => {
    expect(parseCommand('rm /assets/*.png')).toMatchObject({ kind: 'delete', path: null });
  });
});

describe('parseToolArgs', () => {
  it('reads the command out of the arguments the executor reported', () => {
    expect(parseToolArgs('{"command":"cat /index.html"}')).toMatchObject({ kind: 'read', path: '/index.html' });
  });

  it('accepts cmd as well as command', () => {
    expect(parseToolArgs('{"cmd":"ls /"}')?.kind).toBe('list');
  });

  it('has nothing to say about arguments that are still streaming in', () => {
    expect(parseToolArgs('{"command":"cat /ind')).toBeNull();
  });

  it('has nothing to say about arguments that are not a string', () => {
    expect(parseToolArgs({ command: 'cat /index.html' })).toBeNull();
    expect(parseToolArgs(undefined)).toBeNull();
  });

  it('has nothing to say when the arguments carry no command', () => {
    expect(parseToolArgs('{"prompt":"hello"}')).toBeNull();
  });
});

describe('parseCommand, around the shapes the agent actually writes', () => {
  it('still classifies a bare cd as nothing in particular', () => {
    expect(parseCommand('cd /')?.kind).toBe('other');
  });

  it('does not mistake a command merely starting with those letters for a cd', () => {
    expect(parseCommand('cdn-sync /assets')?.kind).toBe('other');
  });

  it('reads a file whose stderr was sent to /dev/null', () => {
    // The read branch refuses any `>` so a real redirect is not read as a read; the stderr form
    // carries no such meaning and must not defeat it.
    expect(parseCommand('cat /.PROMPT.md 2>/dev/null')).toMatchObject({ kind: 'read', path: '/.PROMPT.md' });
    expect(parseCommand('cat /a.md 2>&1')).toMatchObject({ kind: 'read', path: '/a.md' });
  });

  it('still treats a real redirect as a write, not a read', () => {
    expect(parseCommand('cat /a.html > /b.html')).toMatchObject({ kind: 'write', path: '/b.html' });
  });

  it('runs python3, not only python', () => {
    expect(parseCommand('python3 -c "print(1)"')?.kind).toBe('run');
  });
});
