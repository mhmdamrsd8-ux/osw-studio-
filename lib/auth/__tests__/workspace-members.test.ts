import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The workspace tier of the users page: an owner administers their own members without the instance
 * admin rights the old /admin/users page required.
 */

vi.mock('server-only', () => ({}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-ws-members-'));
  vi.resetModules();
  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
});

afterEach(async () => {
  const { closeSystemDatabase } = await import('@/lib/auth/system-database');
  closeSystemDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('studio_view', () => {
  it('defaults to the studio, so no existing account changes view', async () => {
    const { createUser, getUserById } = await import('@/lib/auth/system-database');
    expect(getUserById(createUser('dev@a.test', 'x'))!.studio_view).toBe(1);
  });

  it('can be seeded off for a member added to a workspace', async () => {
    const { createUser, getUserById } = await import('@/lib/auth/system-database');
    expect(getUserById(createUser('client@a.test', 'x', 'Client', 0))!.studio_view).toBe(0);
  });

  it('is written by updateUser, not just accepted by it', async () => {
    const { createUser, updateUser, getUserById } = await import('@/lib/auth/system-database');
    const id = createUser('c@a.test', 'x');
    updateUser(id, { studio_view: 0 });
    expect(getUserById(id)!.studio_view).toBe(0);
    updateUser(id, { studio_view: 1 });
    expect(getUserById(id)!.studio_view).toBe(1);
  });

  it('survives an unrelated update', async () => {
    const { createUser, updateUser, getUserById } = await import('@/lib/auth/system-database');
    const id = createUser('c@a.test', 'x', 'Client', 0);
    updateUser(id, { display_name: 'Renamed' });
    expect(getUserById(id)!.studio_view).toBe(0);
  });
});

describe('listWorkspaceMembers', () => {
  it('carries what the members table renders', async () => {
    const { createUser, createWorkspace, grantWorkspaceAccess, listWorkspaceMembers } =
      await import('@/lib/auth/system-database');

    const owner = createUser('owner@a.test', 'x', 'Owner');
    const workspace = createWorkspace('Acme', owner);
    const client = createUser('client@a.test', 'x', 'Client', 0);
    grantWorkspaceAccess(client, workspace, 'editor');

    const members = listWorkspaceMembers(workspace);
    expect(members.map((m) => m.email).sort()).toEqual(['client@a.test', 'owner@a.test']);

    const seen = members.find((m) => m.email === 'client@a.test')!;
    expect(seen.displayName).toBe('Client');
    expect(seen.role).toBe('editor');
    expect(seen.studioView).toBe(0);
  });

  it("lists only this workspace, so one owner cannot see another's members", async () => {
    const { createUser, createWorkspace, listWorkspaceMembers } =
      await import('@/lib/auth/system-database');

    const a = createUser('a@a.test', 'x');
    const b = createUser('b@b.test', 'x');
    const theirs = createWorkspace('Theirs', b);

    expect(listWorkspaceMembers(createWorkspace('Mine', a)).map((m) => m.email)).toEqual(['a@a.test']);
    expect(listWorkspaceMembers(theirs).map((m) => m.email)).toEqual(['b@b.test']);
  });
});

describe('the owner boundary the members routes rely on', () => {
  it('lets an owner through and stops an editor', async () => {
    const { createUser, createWorkspace, grantWorkspaceAccess, verifyWorkspaceAccess } =
      await import('@/lib/auth/system-database');

    const owner = createUser('owner@a.test', 'x');
    const workspace = createWorkspace('Acme', owner);
    const editor = createUser('editor@a.test', 'x');
    grantWorkspaceAccess(editor, workspace, 'editor');

    expect(() => verifyWorkspaceAccess(owner, workspace, 'owner')).not.toThrow();
    // An editor has full run of the workspace's content but cannot administer who else is in it.
    expect(() => verifyWorkspaceAccess(editor, workspace, 'owner')).toThrow();
    expect(() => verifyWorkspaceAccess(editor, workspace, 'editor')).not.toThrow();
  });

  it('promotes and demotes through grantWorkspaceAccess', async () => {
    const { createUser, createWorkspace, grantWorkspaceAccess, getWorkspaceAccess } =
      await import('@/lib/auth/system-database');

    const owner = createUser('owner@a.test', 'x');
    const workspace = createWorkspace('Acme', owner);
    const member = createUser('m@a.test', 'x');

    grantWorkspaceAccess(member, workspace, 'editor');
    grantWorkspaceAccess(member, workspace, 'owner');
    expect(getWorkspaceAccess(member, workspace)!.role).toBe('owner');
  });

  it('drops only the one workspace when access is revoked', async () => {
    const { createUser, createWorkspace, grantWorkspaceAccess, revokeWorkspaceAccess, getWorkspaceAccess } =
      await import('@/lib/auth/system-database');

    const owner = createUser('owner@a.test', 'x');
    const one = createWorkspace('One', owner);
    const two = createWorkspace('Two', owner);
    const member = createUser('m@a.test', 'x');
    grantWorkspaceAccess(member, one, 'editor');
    grantWorkspaceAccess(member, two, 'editor');

    revokeWorkspaceAccess(member, one);
    expect(getWorkspaceAccess(member, one)).toBeUndefined();
    expect(getWorkspaceAccess(member, two)!.role).toBe('editor');
  });
});

describe('listUsers', () => {
  it('carries studio_view, which an explicit column list is easy to leave out', async () => {
    // The row is cast to Omit<SystemUser, 'password_hash'>, so a missing column is invisible to
    // tsc and surfaces only as every account reading as the simple view.
    const { createUser, listUsers } = await import('@/lib/auth/system-database');
    createUser('studio@a.test', 'x');
    createUser('simple@a.test', 'x', 'Simple', 0);

    const byEmail = Object.fromEntries(listUsers().map((u) => [u.email, u.studio_view]));
    expect(byEmail['studio@a.test']).toBe(1);
    expect(byEmail['simple@a.test']).toBe(0);
  });
});
