'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { VIEW_CHANGED_EVENT, readLocalStudioView } from '@/lib/view-mode-event';

/**
 * The signed-in person's view: the full studio, or the simple one.
 *
 * Seeded on the server, where the session is already known, so the first HTML carries the right menu
 * rather than the full one that a client-side check then has to take apart. That difference is
 * visible: the simple view exists for someone who should never see the developer menu, and rendering
 * it for a frame on every page load is most of what they would notice.
 *
 * Refreshed on `VIEW_CHANGED_EVENT` so a change made anywhere reaches the chrome without a reload.
 *
 * Browser mode has no accounts, so there the view is a per-device preference read straight from
 * storage. It is read in the initial state rather than in an effect because that tree renders on the
 * client to begin with: an effect would show the studio for a frame first, which is most of what the
 * simple view exists to avoid.
 */
const ViewModeContext = createContext<boolean | null>(null);

export function ViewModeProvider({
  initialStudioView,
  children,
}: {
  /** Read from the account row during the server render. Null in browser mode, which has no accounts. */
  initialStudioView: boolean | null;
  children: React.ReactNode;
}) {
  const serverMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  const [studioView, setStudioView] = useState<boolean | null>(
    () => (serverMode ? initialStudioView : readLocalStudioView()),
  );

  const refresh = useCallback(() => {
    if (!serverMode) {
      setStudioView(readLocalStudioView());
      return;
    }
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setStudioView(data?.user?.studioView ?? true))
      .catch(() => { /* keep what the server said */ });
  }, [serverMode]);

  useEffect(() => {
    window.addEventListener(VIEW_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(VIEW_CHANGED_EVENT, refresh);
  }, [refresh]);

  return <ViewModeContext.Provider value={studioView}>{children}</ViewModeContext.Provider>;
}

/**
 * True for the studio, false for the simple view.
 *
 * Defaults to the studio outside a provider: browser mode has no accounts, and every surface that
 * predates the simple view expects the full chrome.
 */
export function useStudioView(): boolean {
  const value = useContext(ViewModeContext);
  return value ?? true;
}
