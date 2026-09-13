import { describe, it, expect } from 'vitest';
import { STUDIO_ONLY_VIEWS } from '@/components/sidebar';

/**
 * The views the simple menu does not offer.
 *
 * `StudioApp` redirects off these to the Dashboard, reading the list from the menu's own table
 * rather than keeping a second copy — so a view whose `studioOnly` changes cannot be dropped from the
 * menu while something else still lands on it.
 */
describe('the simple view\'s hidden top-level views', () => {
  it('covers the ones the menu marks as the studio\'s', () => {
    expect([...STUDIO_ONLY_VIEWS].sort()).toEqual(['interviews', 'skills', 'templates']);
  });

  it('does not hide the views the simple menu is built around', () => {
    // Dashboard included: it is where the simple view starts, and where What's New is shown.
    for (const view of ['dashboard', 'projects', 'deployments', 'settings', 'docs']) {
      expect(STUDIO_ONLY_VIEWS).not.toContain(view);
    }
  });
});
