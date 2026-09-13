/**
 * Workspace Member API
 * PATCH  /api/w/{workspaceId}/users/{userId} — change role, or the member's view
 * DELETE /api/w/{workspaceId}/users/{userId} — remove from this workspace
 *
 * Removing a member revokes their access to this workspace and nothing more: the account, and any
 * other workspace it belongs to, are the instance tier's business.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceOwner } from '@/lib/api/workspace-context';
import {
  getUserById,
  getWorkspaceAccess,
  getWorkspaceById,
  grantWorkspaceAccess,
  revokeWorkspaceAccess,
  updateUser,
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; userId: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspaceOwner(params);
    const { userId } = await params;

    // Membership of *this* workspace is what authorises the edit. Without it an owner could change
    // the dev-mode preference of any account on the instance by guessing an id.
    if (!getWorkspaceAccess(userId, workspaceId)) {
      return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 404 });
    }

    const body = await request.json();

    if (body?.role !== undefined) {
      if (body.role !== 'owner' && body.role !== 'editor') {
        return NextResponse.json({ error: 'Role must be owner or editor' }, { status: 400 });
      }
      const workspace = getWorkspaceById(workspaceId);
      // The workspace's own owner_id is a single column, so demoting that account would leave the
      // workspace pointing at someone with no access to it.
      if (body.role !== 'owner' && workspace?.owner_id === userId) {
        return NextResponse.json({ error: 'The workspace owner cannot be demoted' }, { status: 400 });
      }
      grantWorkspaceAccess(userId, workspaceId, body.role);
    }

    if (body?.studioView !== undefined) {
      updateUser(userId, { studio_view: body.studioView === true ? 1 : 0 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, 'Failed to update member');
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; userId: string }> }
) {
  try {
    const { session, workspaceId } = await requireWorkspaceOwner(params);
    const { userId } = await params;

    const workspace = getWorkspaceById(workspaceId);
    if (workspace?.owner_id === userId) {
      return NextResponse.json({ error: 'Cannot remove the workspace owner' }, { status: 400 });
    }
    if (session.userId === userId) {
      return NextResponse.json({ error: 'Cannot remove yourself' }, { status: 400 });
    }
    if (!getUserById(userId)) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    revokeWorkspaceAccess(userId, workspaceId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, 'Failed to remove member');
  }
}
