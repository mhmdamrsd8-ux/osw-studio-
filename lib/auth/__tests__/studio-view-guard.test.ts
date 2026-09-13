import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Reaching a studio-only view by URL, in server mode.
 *
 * The browser-mode shell keeps the current view in state, so it can watch for one the simple menu
 * does not offer and move off it. Server mode has routes instead: the page renders on its own, and
 * the menu having no entry for it stops nobody typing the address.
 *
 * The last case is the one that keeps this honest over time. The guard has to be applied per page,
 * which the derived `STUDIO_ONLY_VIEWS` list cannot do for itself, so that case reads the list and
 * checks each view's page actually calls it. Marking a new view `studioOnly` then fails here until
 * its page is gated, rather than shipping a view that is hidden from the menu and open by URL.
 */

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUserById: vi.fn(),
  redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT'); }),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/auth/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/auth/system-database', () => ({ getUserById: mocks.getUserById }));

import { requireStudioView } from '@/lib/auth/studio-view-guard';

/** `redirect` throws in Next, so a guard that redirected is one that did not return. */
async function run(workspaceId = 'w1'): Promise<'returned' | 'redirected'> {
  try {
    await requireStudioView(workspaceId);
    return 'returned';
  } catch (error) {
    if (error instanceof Error && error.message === 'NEXT_REDIRECT') return 'redirected';
    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  mocks.getSession.mockResolvedValue({ userId: 'u1' });
  mocks.getUserById.mockReturnValue({ id: 'u1', studio_view: 1 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a signed-in account opening a studio-only view', () => {
  it('gets the page when it is in the studio', async () => {
    expect(await run()).toBe('returned');
  });

  it('is sent to the dashboard when it is in the simple view', async () => {
    mocks.getUserById.mockReturnValue({ id: 'u1', studio_view: 0 });

    expect(await run('w-abc')).toBe('redirected');
    // The workspace goes with it: a bare /dashboard is not a page in server mode.
    expect(mocks.redirect).toHaveBeenCalledWith('/w/w-abc/dashboard');
  });

  it('gets the page when the account row has no such column', async () => {
    // An instance upgrading has the column added with everyone on the studio; a row read before
    // that must not read as the simple view and bounce people off their own pages.
    mocks.getUserById.mockReturnValue({ id: 'u1' });

    expect(await run()).toBe('returned');
  });

  it('gets the page when the account row is missing entirely', async () => {
    // Not this guard's question. The layout and the middleware decide who may be here; answering it
    // with a redirect to the dashboard would turn an auth problem into a confusing bounce.
    mocks.getUserById.mockReturnValue(undefined);

    expect(await run()).toBe('returned');
  });
});

describe('outside a signed-in server-mode request', () => {
  it('does nothing in browser mode, which has no accounts to ask', async () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'false');

    expect(await run()).toBe('returned');
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('leaves an unauthenticated request to the middleware', async () => {
    mocks.getSession.mockResolvedValue(null);

    expect(await run()).toBe('returned');
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });
});

describe('every studio-only view', () => {
  it('has a page that calls the guard', async () => {
    const { STUDIO_ONLY_VIEWS } = await import('@/components/sidebar');
    // The control: an empty list would make the loop below vacuous.
    expect(STUDIO_ONLY_VIEWS.length).toBeGreaterThan(0);

    const ungated = STUDIO_ONLY_VIEWS.filter((view) => {
      const page = path.join(process.cwd(), 'app', 'w', '[workspaceId]', view, 'page.tsx');
      if (!fs.existsSync(page)) return false;
      // The call, not the identifier: the import line carries the name too, so a page that imports
      // the guard and never awaits it would satisfy a looser check while being wide open.
      return !/await\s+requireStudioView\s*\(/.test(fs.readFileSync(page, 'utf8'));
    });

    expect(ungated).toEqual([]);
  });

  it('either has a page or is not a route at all', async () => {
    // A view in the list with no page would make the check above pass by skipping it.
    const { STUDIO_ONLY_VIEWS } = await import('@/components/sidebar');

    const missing = STUDIO_ONLY_VIEWS.filter(
      (view) => !fs.existsSync(path.join(process.cwd(), 'app', 'w', '[workspaceId]', view, 'page.tsx')),
    );

    expect(missing).toEqual([]);
  });
});
