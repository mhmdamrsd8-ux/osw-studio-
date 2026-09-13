import { redirect } from 'next/navigation';

import { getSession } from '@/lib/auth/session';
import { getUserById } from '@/lib/auth/system-database';

/**
 * Keep a simple-view account off a view its menu does not offer.
 *
 * The browser-mode shell holds the current view in state, so `StudioApp` can watch it and move off
 * `STUDIO_ONLY_VIEWS`. Server mode has no such state: each view is a route, and a typed or
 * bookmarked URL reaches the page directly with nothing in between. Without this the simple view was
 * only simple as far as the menu, and `/w/{id}/skills` rendered the panel it exists to hide.
 *
 * The destination matches the browser-mode redirect: the dashboard, which the simple view keeps.
 *
 * Nothing here is an access check. The account can read this workspace, and the pages it is applied
 * to hold no one else's data -- the layout has already established membership. This is about the
 * chrome a person chose, so a missing session or a missing account row is left to the layout and the
 * middleware, which answer it properly, rather than being second-guessed into a redirect here.
 */
export async function requireStudioView(workspaceId: string): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;

  const session = await getSession();
  if (!session) return;

  const user = getUserById(session.userId);
  // Absent row, absent column: the studio, the same default the account carries everywhere else.
  if ((user?.studio_view ?? 1) === 1) return;

  redirect(`/w/${workspaceId}/dashboard`);
}
