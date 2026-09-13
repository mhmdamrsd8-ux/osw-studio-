/**
 * Announces that the signed-in person's view (studio or simple) has changed.
 *
 * The sidebar reads the view once when it mounts. Without this, changing it from the users page
 * updates the database and nothing else, so the menu keeps its old shape until the next full reload
 * and the setting reads as having done nothing.
 */
export const VIEW_CHANGED_EVENT = 'osw-view-changed';

export function emitViewChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(VIEW_CHANGED_EVENT));
}

/**
 * Where the view is kept in browser mode.
 *
 * Server mode holds it on the account row (`users.studio_view`), which browser mode has no equivalent
 * for — there are no accounts. It is a per-device preference there, alongside the theme and the
 * preview's device size.
 */
const LOCAL_VIEW_KEY = 'osw-studio-view';

/** True for the studio, false for the simple view. Studio unless this device has chosen otherwise. */
export function readLocalStudioView(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return localStorage.getItem(LOCAL_VIEW_KEY) !== 'simple';
  } catch {
    // Private-mode storage refuses reads; the studio is the safe answer.
    return true;
  }
}

export function writeLocalStudioView(studioView: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LOCAL_VIEW_KEY, studioView ? 'studio' : 'simple');
  } catch {
    // Nothing to do: the choice lasts for this page instead of for this device.
  }
  emitViewChanged();
}
