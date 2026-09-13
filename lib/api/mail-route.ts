/**
 * Shared guards and error mapping for the mail routes.
 *
 * The seven mail endpoints differ only in which tier they touch; the auth in front of them is the
 * same two shapes repeated. Keeping them here means the workspace tier cannot drift to a weaker
 * role than the instance tier by being edited in one file and not the other.
 *
 * Both tiers require more than membership. Instance settings are admin-only; workspace settings are
 * owner-only, because an editor can act on client feedback but changing where a client's mail
 * appears to come from is a decision about the agency's identity. `verifyWorkspaceAccess` also lets
 * an instance admin through unconditionally, which is deliberate, they can read the database this
 * is stored in regardless.
 */

import 'server-only';

import { NextResponse } from 'next/server';
import { requireAuth, type SessionData } from '@/lib/auth/session';
import { isSmtpSecurity, type SmtpSecurity } from '@/lib/mail/settings';

export interface SmtpFields {
  host?: string | null;
  port?: number | null;
  secure?: SmtpSecurity;
  user?: string | null;
  password?: string | null;
  from?: string | null;
}

/**
 * A display name, not a byline. It renders in the From line of every message the workspace sends.
 * Same size as the review participant's name in lib/review/participant-input.ts, for the same
 * reason: a field that appears in front of a recipient is not a place to store prose.
 */
export const MAX_MAIL_DISPLAY_NAME = 80;

/**
 * A generous ceiling for the connection fields. RFC 5321 caps a reverse-path at 254 octets and a
 * domain at 255, so nothing legitimate comes near this; it is here so a settings row cannot be used
 * as storage.
 */
const MAX_SMTP_FIELD = 320;

/**
 * The characters that end a header line, or truncate one.
 *
 * Refused rather than stripped, and refused at the boundary that accepts the value rather than in
 * the formatter that consumes it, the same choice lib/review/participant-input.ts makes for a
 * participant's address, and for the same reason: a value that only fails at send time has already
 * been persisted and handed to the mailer. `from` and `displayName` both reach a `From:` header
 * verbatim, and in `instance` mode a workspace's display name rides on the *instance's* address, so
 * a tenant's newline would be sent from the operator's own domain. The connection fields are held
 * to the same rule because they are spoken into an SMTP session, where a line break is a command.
 *
 * Narrower than the participant-email guard, which also excludes commas, spaces and angle brackets:
 * those are all legal in an agency's display name and in a `Name <address>` From field.
 */
const HEADER_INJECTION = /[\r\n\0]/;

/** A field bound for a header or an SMTP command, or the error explaining why it is not one. */
function checkHeaderSafe(key: string, value: string, maxLength: number): string | null {
  if (HEADER_INJECTION.test(value)) {
    return `${key} must not contain line breaks`;
  }
  if (value.length > maxLength) {
    return `${key} exceeds ${maxLength} characters`;
  }
  return null;
}

/**
 * Validate a display name from a settings body: absent leaves it alone, null clears it.
 *
 * Shared by the tiers that have one so the cap and the refusal cannot drift apart.
 */
export function parseDisplayName(
  value: unknown
): { displayName?: string | null } | { error: string } {
  if (value === undefined) return {};
  if (value === null) return { displayName: null };
  if (typeof value !== 'string') return { error: 'displayName must be a string' };

  const error = checkHeaderSafe('displayName', value, MAX_MAIL_DISPLAY_NAME);
  return error ? { error } : { displayName: value };
}

/**
 * Validate the SMTP half of a settings body.
 *
 * An absent key means "leave this alone" and is passed through as `undefined`, which is what makes
 * a form that cannot render the stored password able to save the rest of the form. `null` clears.
 */
export function parseSmtpFields(body: Record<string, unknown>): { fields: SmtpFields } | { error: string } {
  const fields: SmtpFields = {};

  for (const key of ['host', 'user', 'password', 'from'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') return { error: `${key} must be a string` };
    if (value !== null) {
      const error = checkHeaderSafe(key, value, MAX_SMTP_FIELD);
      if (error) return { error };
    }
    fields[key] = value;
  }

  if (body.port !== undefined) {
    if (body.port === null) {
      fields.port = null;
    } else {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { error: 'port must be a whole number between 1 and 65535' };
      }
      fields.port = port;
    }
  }

  if (body.secure !== undefined) {
    if (!isSmtpSecurity(body.secure)) {
      return { error: "secure must be one of 'starttls', 'ssl' or 'none'" };
    }
    fields.secure = body.secure;
  }

  return { fields };
}

export async function requireAdmin(): Promise<SessionData> {
  const session = await requireAuth();
  if (!session.isAdmin) throw new Error('Admin access required');
  return session;
}

export { requireWorkspaceOwner } from '@/lib/api/workspace-context';

/**
 * Maps the guard failures onto status codes, and refuses to say anything else about the error.
 *
 * The fallback is a fixed string with no cause attached: an unexpected failure in here has a stored
 * SMTP configuration in scope, and echoing an exception message is how a password ends up in a
 * browser's network tab.
 */
export function mailErrorResponse(error: unknown, fallback: string): NextResponse {
  const message = error instanceof Error ? error.message : '';

  if (message === 'Unauthorized') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (
    message === 'Admin access required' ||
    message === 'Workspace access denied' ||
    message === 'Insufficient workspace permissions'
  ) {
    return NextResponse.json({ error: message }, { status: 403 });
  }

  return NextResponse.json({ error: fallback }, { status: 500 });
}
