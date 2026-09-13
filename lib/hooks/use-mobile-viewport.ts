'use client';

import { useEffect, useState } from 'react';

/** Tailwind's `md`. The workspace's two trees switch at exactly this width. */
const MD_BREAKPOINT_PX = 768;

/**
 * Whether the viewport is narrow enough that the mobile tree is the one on screen.
 *
 * The workspace renders both trees at once — desktop is `hidden md:flex`, mobile is
 * `flex md:hidden` — so which one is *visible* is a media query, not a mount. Anything that has to
 * address the visible one (the Inspector talks to a specific iframe) needs that as a value.
 *
 * Reports `false` until the first effect runs, so the first paint assumes desktop. That is safe for
 * the current callers, which only read it inside handlers that a person has to trigger, but it is
 * the wrong answer for anything that must be correct during the initial render.
 */
export function useMobileViewport(): boolean {
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MD_BREAKPOINT_PX - 0.02}px)`);
    const sync = () => setMobile(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return mobile;
}
