import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The account's view, over the wire.
 *
 * This is the one contract the client half cannot check for itself. `ViewModeProvider` and the
 * Appearance pane both stub `fetch`, so they assert against their own idea of the payload: if this
 * route named the field anything else, every one of those tests would still pass and the app would
 * read `undefined` and put everyone in the studio.
 *
 * So the field name is asserted here, on both sides, against a real database -- the PATCH writes and
 * the GET reads the same row, which is what makes a half-applied rename fail rather than agree with
 * itself.
 *
 * Only `getSession` is mocked. Who the caller is has to come from somewhere, and it is also the
 * thing the write is scoped to.
 */

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let dir: string;

async function routes() {
  return import('@/app/api/auth/me/route');
}

type MeResponse = {
  authenticated: boolean;
  user?: { userId: string; email: string; isAdmin: boolean; studioView: boolean; workspaceRoles: Record<string, string> };
  error?: string;
};

async function get(): Promise<{ status: number; body: MeResponse }> {
  const { GET } = await routes();
  const res = await GET();
  return { status: res.status, body: await res.json() };
}

async function patch(body: unknown): Promise<{ status: number; body: { success?: boolean; error?: string } }> {
  const { PATCH } = await routes();
  const res = await PATCH(new Request('http://localhost/api/auth/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

/** An account in the real database, with its stored column set directly. */
async function seedUser(email: string, storedStudioView: number): Promise<string> {
  const { createUser, updateUser } = await import('@/lib/auth/system-database');
  const id = createUser(email, 'hash');
  updateUser(id, { studio_view: storedStudioView });
  return id;
}

async function storedStudioView(id: string): Promise<number | undefined> {
  const { getUserById } = await import('@/lib/auth/system-database');
  return getUserById(id)?.studio_view;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-me-route-'));
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
});

afterEach(async () => {
  const { closeSystemDatabase } = await import('@/lib/auth/system-database');
  closeSystemDatabase();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET, which is what the chrome reads the view from', () => {
  it('reports the studio as studioView true', async () => {
    const id = await seedUser('studio@a.test', 1);
    mocks.getSession.mockResolvedValue({ userId: id, email: 'studio@a.test', isAdmin: false });

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body.user?.studioView).toBe(true);
  });

  it('reports the simple view as studioView false', async () => {
    const id = await seedUser('simple@a.test', 0);
    mocks.getSession.mockResolvedValue({ userId: id, email: 'simple@a.test', isAdmin: false });

    const { body } = await get();

    expect(body.user?.studioView).toBe(false);
  });

  it('reports the studio for a session whose account row is gone', async () => {
    mocks.getSession.mockResolvedValue({ userId: 'no-such-user', email: 'x@a.test', isAdmin: false });

    const { body } = await get();

    // The safe answer: the chrome someone already had, rather than the cut-down one they never chose.
    expect(body.user?.studioView).toBe(true);
  });

  it('says so plainly when nobody is signed in', async () => {
    mocks.getSession.mockResolvedValue(null);

    const { status, body } = await get();

    expect(status).toBe(200);
    expect(body).toEqual({ authenticated: false });
  });
});

describe('PATCH, which is how a person changes their own view', () => {
  it('writes the simple view and the next read agrees', async () => {
    const id = await seedUser('a@a.test', 1);
    mocks.getSession.mockResolvedValue({ userId: id, email: 'a@a.test', isAdmin: false });

    const { status } = await patch({ studioView: false });

    expect(status).toBe(200);
    // Both halves of the round trip, which is what a half-applied rename breaks.
    expect(await storedStudioView(id)).toBe(0);
    expect((await get()).body.user?.studioView).toBe(false);
  });

  it('writes the studio back', async () => {
    const id = await seedUser('a@a.test', 0);
    mocks.getSession.mockResolvedValue({ userId: id, email: 'a@a.test', isAdmin: false });

    await patch({ studioView: true });

    expect(await storedStudioView(id)).toBe(1);
  });

  it('refuses a body that does not carry the field', async () => {
    const id = await seedUser('a@a.test', 1);
    mocks.getSession.mockResolvedValue({ userId: id, email: 'a@a.test', isAdmin: false });

    const { status } = await patch({ somethingElse: true });

    expect(status).toBe(400);
    expect(await storedStudioView(id)).toBe(1);
  });

  it('changes only the caller, whatever account the body names', async () => {
    const caller = await seedUser('caller@a.test', 1);
    const other = await seedUser('other@a.test', 1);
    mocks.getSession.mockResolvedValue({ userId: caller, email: 'caller@a.test', isAdmin: false });

    await patch({ studioView: false, userId: other, id: other });

    expect(await storedStudioView(caller)).toBe(0);
    expect(await storedStudioView(other)).toBe(1);
  });

  it('turns anything but true into the simple view rather than storing it', async () => {
    // `studio_view` is an INTEGER NOT NULL; the route narrows to 1 or 0 so a stray string cannot
    // reach the column and read as neither view afterwards.
    const id = await seedUser('a@a.test', 1);
    mocks.getSession.mockResolvedValue({ userId: id, email: 'a@a.test', isAdmin: false });

    await patch({ studioView: 'yes please' });

    expect(await storedStudioView(id)).toBe(0);
  });

  it('refuses an unauthenticated caller', async () => {
    mocks.getSession.mockResolvedValue(null);

    const { status } = await patch({ studioView: false });

    expect(status).toBe(401);
  });
});
