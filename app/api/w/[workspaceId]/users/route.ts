/**
 * Workspace Members API
 * GET  /api/w/{workspaceId}/users — the workspace's members
 * POST /api/w/{workspaceId}/users — add one, creating the account if the email is new
 *
 * The workspace tier of the users page. Owner-only, and scoped to this workspace: it can neither
 * see nor touch an account's membership of any other. The instance tier, every user and every
 * workspace, stays on /api/admin/users behind the admin check.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceOwner } from '@/lib/api/workspace-context';
import { hashPassword } from '@/lib/auth/passwords';
import {
  createUser,
  getUserByEmail,
  getWorkspaceById,
  grantWorkspaceAccess,
  listWorkspaceMembers,
  setDefaultWorkspace,
} from '@/lib/auth/system-database';

function errorResponse(error: unknown, fallback: string): NextResponse {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Unauthorized') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (message === 'Workspace access denied' || message === 'Insufficient workspace permissions') {
    return NextResponse.json({ error: 'Workspace owner access required' }, { status: 403 });
  }
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspaceOwner(params);
    return NextResponse.json({ members: listWorkspaceMembers(workspaceId) });
  } catch (error) {
    return errorResponse(error, 'Failed to load members');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspaceOwner(params);

    const body = await request.json();
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
    const role = body?.role === 'owner' ? 'owner' : 'editor';
    const studioView = body?.studioView === true ? 1 : 0;

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    const existing = getUserByEmail(email);

    if (existing) {
      // Attaching an account that already exists. Its dev-mode preference is the person's own and is
      // left alone: they may already be working in another workspace under a setting they chose.
      if (listWorkspaceMembers(workspaceId).some((m) => m.userId === existing.id)) {
        return NextResponse.json({ error: 'That user is already a member' }, { status: 409 });
      }
      grantWorkspaceAccess(existing.id, workspaceId, role);
      return NextResponse.json({ userId: existing.id, created: false }, { status: 201 });
    }

    // A new account. The owner is setting up someone who has never signed in, so a password is the
    // only way in; there is no invitation flow to fall back on.
    if (!password) {
      return NextResponse.json(
        { error: 'No account exists for that email, so a password is required to create one' },
        { status: 400 }
      );
    }

    const workspace = getWorkspaceById(workspaceId);
    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const userId = createUser(email, await hashPassword(password), displayName || undefined, studioView);
    grantWorkspaceAccess(userId, workspaceId, role);
    // Their only workspace, so it is also where they land.
    setDefaultWorkspace(userId, workspaceId);

    return NextResponse.json({ userId, created: true }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'Failed to add member');
  }
}
