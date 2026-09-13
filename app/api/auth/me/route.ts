/**
 * Current User API Route
 *
 * Returns current session information
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getUserById, listUserWorkspaces, updateUser } from '@/lib/auth/system-database';
import { logger } from '@/lib/utils';

export async function GET() {
  try {
    const session = await getSession();

    if (!session) {
      return NextResponse.json({ authenticated: false }, { status: 200 });
    }

    // Read from the row rather than the session: the preference can be changed by an owner, or by
    // the user themselves, without reissuing the cookie they are already holding.
    const user = getUserById(session.userId);

    // The caller's own role per workspace. Only their memberships, so this discloses nothing they
    // could not already read, and it saves every surface that gates on ownership a second request.
    const workspaceRoles: Record<string, string> = {};
    for (const workspace of listUserWorkspaces(session.userId)) {
      workspaceRoles[workspace.id] = workspace.role;
    }

    return NextResponse.json({
      authenticated: true,
      user: {
        userId: session.userId,
        email: session.email,
        isAdmin: session.isAdmin,
        studioView: (user?.studio_view ?? 1) === 1,
        workspaceRoles,
      },
    });
  } catch (error) {
    logger.error('[API /api/auth/me] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get session' },
      { status: 500 }
    );
  }
}

/**
 * The caller changing their own view.
 *
 * Separate from the admin and owner routes because it is the one thing a person may set on their own
 * account: it decides what the chrome shows them, not what they are allowed to do, so nobody has to
 * be an owner to get out of the simple view. Only `studioView` is accepted, and only for the session's
 * own user id.
 */
export async function PATCH(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    if (body?.studioView === undefined) {
      return NextResponse.json({ error: 'studioView is required' }, { status: 400 });
    }

    updateUser(session.userId, { studio_view: body.studioView === true ? 1 : 0 });
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[API /api/auth/me] PATCH error:', error);
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
  }
}
