import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * `users.studio_view` on a database that predates it.
 *
 * The column is added by migration rather than being in the `CREATE TABLE`, so an instance that has
 * been running gets it on the next start. The default decides what every existing account sees, and
 * getting it wrong the other way would put people who never asked for it into the cut-down chrome.
 *
 * Runs the real `initSystemDatabase` against a real file, because the question is what happens to
 * rows that were already there. A database created by this version is covered by the `studio_view`
 * block in `workspace-members.test.ts`, which asserts the default on a freshly made account.
 */

vi.mock('server-only', () => ({}));

let dir: string;
let dbPath: string;

/** The same table before the setting existed at all. */
function seedWithoutTheColumn(rows: Array<{ id: string; email: string }>) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.prepare(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      default_workspace_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `).run();
  const insert = db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.email, 'hash');
  db.close();
}

function columns(): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  db.close();
  return rows.map((r) => r.name);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-studio-view-'));
  dbPath = path.join(dir, 'data', 'system.sqlite');
  vi.resetModules();
  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
});

afterEach(async () => {
  const { closeSystemDatabase } = await import('@/lib/auth/system-database');
  closeSystemDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a database from before the setting existed', () => {
  it('adds the column with everyone on the studio', async () => {
    // Nothing to preserve here, and the studio is the view these accounts have been using.
    seedWithoutTheColumn([{ id: 'u1', email: 'a@a.test' }]);

    const { getUserById } = await import('@/lib/auth/system-database');

    expect(getUserById('u1')!.studio_view).toBe(1);
  });
});
