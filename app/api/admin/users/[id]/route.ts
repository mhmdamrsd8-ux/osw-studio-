/**
 * Admin User Detail API
 * GET /api/admin/users/[id] - Get user details with deployments
 * PUT /api/admin/users/[id] - Update user
 * DELETE /api/admin/users/[id] - Delete user
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, verifyInstanceApiKey } from '@/lib/auth/session';
import { getUserById, updateUser, deactivateUser, listUserWorkspaces } from '@/lib/auth/system-database';
import { hashPassword } from '@/lib/auth/passwords';


export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const apiSession = verifyInstanceApiKey(request);
    const session = apiSession || await requireAuth();
    if (!session.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { id } = await params;
    const user = getUserById(id);
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      isAdmin: user.is_admin === 1,
      active: user.active === 1,
      workspaces: listUserWorkspaces(user.id),
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Failed to get user' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const apiSession = verifyInstanceApiKey(request);
    const session = apiSession || await requireAuth();
    if (!session.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json();

    const user = getUserById(id);
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    let passwordHash: string | undefined;
    if (body.password) {
      if (typeof body.password !== 'string' || body.password.length < 8) {
        return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
      }
      passwordHash = await hashPassword(body.password);
    }

    if (body.isAdmin !== undefined && id === session.userId) {
      return NextResponse.json({ error: 'Cannot change your own admin status' }, { status: 400 });
    }

    updateUser(id, {
      active: body.active !== undefined ? (body.active ? 1 : 0) : undefined,
      display_name: body.displayName,
      password_hash: passwordHash,
      is_admin: body.isAdmin !== undefined ? (body.isAdmin ? 1 : 0) : undefined,
      studio_view: body.studioView !== undefined ? (body.studioView ? 1 : 0) : undefined,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const apiSession = verifyInstanceApiKey(request);
    const session = apiSession || await requireAuth();
    if (!session.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { id } = await params;

    // Prevent self-deletion
    if (id === session.userId) {
      return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 400 });
    }

    deactivateUser(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 });
  }
}
