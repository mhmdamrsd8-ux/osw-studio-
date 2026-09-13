import { describe, it, expect } from 'vitest';
import { SETTINGS_PANE_IDS } from '@/components/unified-settings';

/**
 * The settings URL parser used to keep its own list of valid panes. A pane added to the definitions
 * but not to that list was silently rejected, and `?settings=<it>` fell back to the first pane
 * rather than failing visibly. These pin the derivation so the two cannot drift apart again.
 */
describe('settings pane ids', () => {
  it('includes every pane the settings page offers', () => {
    expect([...SETTINGS_PANE_IDS].sort()).toEqual([
      'appearance', 'connections', 'costs', 'data', 'mail', 'models', 'permissions', 'templates', 'users',
    ]);
  });

  it('has no duplicates, so a pane cannot be declared twice', () => {
    expect(new Set(SETTINGS_PANE_IDS).size).toBe(SETTINGS_PANE_IDS.length);
  });

  it('is what the URL parser accepts, not a second list', async () => {
    // Reads the source rather than the behaviour: the parser builds its Set at module scope from
    // this export, and the thing worth pinning is that it has no literal list of its own.
    const fs = await import('fs');
    const source = fs.readFileSync('components/views/settings-view.tsx', 'utf8');
    expect(source).toContain('new Set<SettingsPane>(SETTINGS_PANE_IDS)');
    expect(source).not.toMatch(/'connections',\s*'models'/);
  });
});
