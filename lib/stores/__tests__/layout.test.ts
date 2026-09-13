import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockLocalStorage: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (key: string) => mockLocalStorage[key] ?? null,
  setItem: (key: string, value: string) => { mockLocalStorage[key] = value; },
  removeItem: (key: string) => { delete mockLocalStorage[key]; },
});

import { createStore } from 'zustand/vanilla';
import { createLayoutSlice, LayoutSlice, PANEL_MAP, pickEvictionTarget, visiblePanelKeys } from '../slices/layout';

function createLayoutStore() {
  return createStore<LayoutSlice>()((...a) => ({
    ...createLayoutSlice(...a),
  }));
}

describe('layout slice', () => {
  let store: ReturnType<typeof createLayoutStore>;

  beforeEach(() => {
    for (const key of Object.keys(mockLocalStorage)) delete mockLocalStorage[key];
    store = createLayoutStore();
  });

  it('starts with default panel visibility', () => {
    const s = store.getState();
    expect(s.showChat).toBe(true);
    expect(s.showFiles).toBe(true);
    expect(s.showEditor).toBe(false);
    expect(s.showPreview).toBe(true);
  });

  it('togglePanel flips visibility', () => {
    store.getState().togglePanel('editor');
    expect(store.getState().showEditor).toBe(true);
    store.getState().togglePanel('editor');
    expect(store.getState().showEditor).toBe(false);
  });

  it('setPanelOrder updates order', () => {
    const newOrder = ['preview', 'chat', 'files', 'editor', 'console', 'checkpoints', 'debug', 'skills'];
    store.getState().setPanelOrder(newOrder);
    expect(store.getState().panelOrder).toEqual(newOrder);
  });

  it('setActiveMobilePanel sets panel and closes overflow', () => {
    store.setState({ mobileOverflowOpen: true });
    store.getState().setActiveMobilePanel('editor');
    expect(store.getState().activeMobilePanel).toBe('editor');
    expect(store.getState().mobileOverflowOpen).toBe(false);
  });

  it('startDrag / endDrag manage drag state', () => {
    store.getState().startDrag('chat');
    expect(store.getState().draggingPanel).toBe('chat');
    store.getState().endDrag();
    expect(store.getState().draggingPanel).toBeNull();
    expect(store.getState().dropTarget).toBeNull();
  });

  it('resetLayout clears transient state but keeps panel visibility', () => {
    store.getState().togglePanel('editor');
    store.setState({ draggingPanel: 'chat', mobileOverflowOpen: true });
    store.getState().resetLayout();
    expect(store.getState().draggingPanel).toBeNull();
    expect(store.getState().mobileOverflowOpen).toBe(false);
    expect(store.getState().showEditor).toBe(true); // preserved
  });

  it('initLayout reloads panel order from localStorage, appending panels stored orders predate', () => {
    // An existing user's stored order was written before the Elements panel existed. The stored
    // sequence must survive verbatim and the unknown-to-it panel must be appended, not dropped —
    // this is the whole migration story for panel registration.
    const customOrder = ['preview', 'chat', 'files', 'editor', 'skills', 'console', 'checkpoints', 'debug'];
    mockLocalStorage['osw-workspace-panel-order'] = JSON.stringify(customOrder);
    store.getState().initLayout();

    const order = store.getState().panelOrder;
    expect(order.slice(0, customOrder.length)).toEqual(customOrder);
    expect(order).toContain('elements');
    // No duplicates, and nothing registered is missing.
    expect(new Set(order).size).toBe(order.length);
    expect([...order].sort()).toEqual(Object.keys(PANEL_MAP).sort());
  });

  it('drops unknown keys from a stored order', () => {
    mockLocalStorage['osw-workspace-panel-order'] = JSON.stringify(['chat', 'ghost-panel', 'files']);
    store.getState().initLayout();
    expect(store.getState().panelOrder).not.toContain('ghost-panel');
    expect(store.getState().panelOrder.slice(0, 2)).toEqual(['chat', 'files']);
  });

  describe('elements panel registration', () => {
    it('is hidden by default and is a known panel', () => {
      expect(store.getState().showElements).toBe(false);
      expect(PANEL_MAP.elements).toBe('showElements');
      expect(store.getState().panelOrder).toContain('elements');
    });

    it('togglePanel flips it and persists it', () => {
      store.getState().togglePanel('elements');
      expect(store.getState().showElements).toBe(true);
      expect(JSON.parse(mockLocalStorage['osw-workspace-panels']).elements).toBe(true);

      store.getState().togglePanel('elements');
      expect(store.getState().showElements).toBe(false);
      expect(JSON.parse(mockLocalStorage['osw-workspace-panels']).elements).toBe(false);
    });

    it('restores a persisted open state on a fresh store', () => {
      store.getState().togglePanel('elements');
      const revived = createLayoutStore();
      expect(revived.getState().showElements).toBe(true);
    });

    it('opening it does not cost you the preview', () => {
      // Defaults are chat + files + preview, which is already the three-panel maximum, and preview
      // sits rightmost of the three in the default order — so the naive "close the rightmost open
      // panel" rule would unmount the very iframe the tree reads.
      expect(store.getState().showPreview).toBe(true);
      store.getState().togglePanel('elements');

      expect(store.getState().showElements).toBe(true);
      expect(store.getState().showPreview).toBe(true);
      expect(visiblePanelKeys(store.getState())).toContain('preview');
      // Still exactly three panels: something else made way.
      expect(visiblePanelKeys(store.getState())).toHaveLength(3);
    });

    it('evicts the preview only when it is the sole candidate', () => {
      // A layout of preview + elements alone cannot exercise the guard (two panels leaves room),
      // so drive it to the limit with the preview as the rightmost non-elements panel available.
      store.setState({
        showChat: false, showFiles: false, showEditor: true, showConsole: true,
        showPreview: true, showCheckpoints: false, showDebugPanel: false,
        showSkillsPanel: false, showElements: false,
      });
      store.getState().togglePanel('elements');
      // editor and console are evictable, so the preview survives.
      expect(store.getState().showPreview).toBe(true);
      expect(visiblePanelKeys(store.getState())).toHaveLength(3);
    });

    it('closing it is always allowed and never evicts anything', () => {
      store.getState().togglePanel('elements');
      const before = visiblePanelKeys(store.getState()).filter(k => k !== 'elements');
      store.getState().togglePanel('elements');
      expect(store.getState().showElements).toBe(false);
      expect(visiblePanelKeys(store.getState())).toEqual(before);
    });
  });

  /**
   * The element picker's armed flag.
   *
   * It is here rather than in `multipage-preview`'s own `useState` so that a *second* control can arm
   * it — the Styles tab's `Select element` button, which cannot reach a ref that is still null at the
   * moment it opens the panel that mounts the preview. These assertions are what stop it drifting
   * back into being persisted layout or surviving a project switch.
   */
  describe('pickEvictionTarget', () => {
    /**
     * Which panel makes way, asserted directly.
     *
     * The panel tests above can only see that *something* closed and the count held at three, which
     * every candidate satisfies equally — so the rule itself, rightmost-first, was never pinned.
     */
    const open = (...keys: string[]) =>
      ['chat', 'files', 'editor', 'preview', 'console'].map(key => ({ key, open: keys.includes(key) }));

    it('closes the rightmost open panel, not the leftmost', () => {
      expect(pickEvictionTarget(open('chat', 'files', 'console'), 'elements')).toBe('console');
      expect(pickEvictionTarget(open('chat', 'editor'), 'elements')).toBe('editor');
    });

    it('spares the companion of the panel being opened', () => {
      // Elements reads the preview's document, so opening it must never be what unmounts the iframe.
      expect(pickEvictionTarget(open('chat', 'files', 'preview'), 'elements')).toBe('files');
    });

    it('falls back to the companion when it is the only thing left to close', () => {
      // Better a preview that closes than an open that silently does nothing.
      expect(pickEvictionTarget(open('preview'), 'elements')).toBe('preview');
    });

    it('never picks the panel being opened', () => {
      expect(pickEvictionTarget(open('chat', 'editor'), 'editor')).toBe('chat');
    });

    it('answers null when there is nothing to close', () => {
      expect(pickEvictionTarget(open(), 'elements')).toBeNull();
      expect(pickEvictionTarget(open('elements'), 'elements')).toBeNull();
    });
  });

  describe('focusToolArmed', () => {
    it('starts disarmed and is set by setFocusToolArmed', () => {
      expect(store.getState().focusToolArmed).toBe(false);
      store.getState().setFocusToolArmed(true);
      expect(store.getState().focusToolArmed).toBe(true);
      store.getState().setFocusToolArmed(false);
      expect(store.getState().focusToolArmed).toBe(false);
    });

    it('is never persisted, so a reload does not come up armed', () => {
      store.getState().setFocusToolArmed(true);
      // Something else has to write the panels key, since arming must not write it itself.
      store.getState().togglePanel('editor');
      expect(JSON.parse(mockLocalStorage['osw-workspace-panels'])).not.toHaveProperty('focusToolArmed');
      expect(createLayoutStore().getState().focusToolArmed).toBe(false);
    });

    it('is cleared by resetLayout, so it cannot follow you to the next project', () => {
      // resetLayout runs unconditionally in the workspace's unmount cleanup. An armed picker left
      // behind would make the next project's preview swallow its first click.
      store.getState().setFocusToolArmed(true);
      store.getState().resetLayout();
      expect(store.getState().focusToolArmed).toBe(false);
    });
  });

  /**
   * The hover hint that links the Inspector's `Select element` button to the preview header's
   * crosshair — two controls for one tool, in components whose nearest common ancestor is the
   * workspace, which is why a hover has to travel through the store at all.
   *
   * Nothing behaves differently while it is true; it is a tint. That is exactly why it needs these
   * assertions: a stuck hint is invisible to every other test in the suite and shows up only as a
   * crosshair that is mysteriously highlighted with the pointer nowhere near it.
   */
  describe('focusToolHinted', () => {
    it('starts clear and is set by setFocusToolHinted', () => {
      expect(store.getState().focusToolHinted).toBe(false);
      store.getState().setFocusToolHinted(true);
      expect(store.getState().focusToolHinted).toBe(true);
      store.getState().setFocusToolHinted(false);
      expect(store.getState().focusToolHinted).toBe(false);
    });

    it('is never persisted — a reload cannot come up hinting at a pointer that is gone', () => {
      store.getState().setFocusToolHinted(true);
      // Something else has to write the panels key, since hinting must not write it itself.
      store.getState().togglePanel('editor');
      expect(JSON.parse(mockLocalStorage['osw-workspace-panels'])).not.toHaveProperty('focusToolHinted');
      expect(createLayoutStore().getState().focusToolHinted).toBe(false);
    });

    it('is cleared by resetLayout', () => {
      store.getState().setFocusToolHinted(true);
      store.getState().resetLayout();
      expect(store.getState().focusToolHinted).toBe(false);
    });

    it('is independent of the armed flag — arming is not hinting', () => {
      // They travel together through one handler but mean different things: one is a mode the next
      // click obeys, the other is a pointer's whereabouts. Tying them would tint the crosshair for
      // as long as the picker stayed armed.
      store.getState().setFocusToolHinted(true);
      expect(store.getState().focusToolArmed).toBe(false);
      store.getState().setFocusToolArmed(true);
      store.getState().setFocusToolHinted(false);
      expect(store.getState().focusToolArmed).toBe(true);
    });
  });

  describe('projectSettingsSection', () => {
    it('starts null, since nothing has asked for a section', () => {
      expect(store.getState().projectSettingsSection).toBeNull();
    });

    it('holds the section the opener asked for', () => {
      store.getState().setShowProjectSettingsModal(true, 'suggestions');
      expect(store.getState().showProjectSettingsModal).toBe(true);
      expect(store.getState().projectSettingsSection).toBe('suggestions');
    });

    it('opens with no section when none was asked for', () => {
      store.getState().setShowProjectSettingsModal(true);
      expect(store.getState().projectSettingsSection).toBeNull();
    });

    it('does not carry a section into the next open by another route', () => {
      // The whole point of the field: a later open must not jump to what was last requested.
      store.getState().setShowProjectSettingsModal(true, 'suggestions');
      store.getState().setShowProjectSettingsModal(false);
      store.getState().setShowProjectSettingsModal(true);
      expect(store.getState().projectSettingsSection).toBeNull();
    });

    it('is cleared when the dialog closes', () => {
      store.getState().setShowProjectSettingsModal(true, 'suggestions');
      store.getState().setShowProjectSettingsModal(false);
      expect(store.getState().projectSettingsSection).toBeNull();
    });

    it('is cleared on close even when a section is passed with it', () => {
      // Closing owns the field regardless of arguments, so a stale section cannot outlive the
      // dialog by any call shape.
      store.getState().setShowProjectSettingsModal(true, 'suggestions');
      store.getState().setShowProjectSettingsModal(false, 'suggestions');
      expect(store.getState().projectSettingsSection).toBeNull();
    });

    it('is cleared by clearProjectSettingsSection while the dialog stays open', () => {
      // The dialog calls this once it has scrolled, so a re-render does not scroll again.
      store.getState().setShowProjectSettingsModal(true, 'suggestions');
      store.getState().clearProjectSettingsSection();
      expect(store.getState().projectSettingsSection).toBeNull();
      expect(store.getState().showProjectSettingsModal).toBe(true);
    });
  });

  describe('visiblePanelKeys', () => {
    it('lists open panels in panel order', () => {
      store.setState({ panelOrder: ['debug', 'preview', 'chat', 'files', 'elements'] });
      store.setState({ showChat: true, showFiles: false, showPreview: true, showElements: true });
      expect(visiblePanelKeys(store.getState())).toEqual(['preview', 'chat', 'elements']);
    });

    it('covers every registered panel, so the workspace cannot half-see one', () => {
      // The workspace sizes panels and computes drop indices from this list. A panel that is in
      // PANEL_MAP but invisible here would desynchronise both.
      const order = Object.keys(PANEL_MAP);
      const allOpen = { ...store.getState() } as unknown as Record<string, unknown>;
      for (const flag of Object.values(PANEL_MAP)) allOpen[flag] = true;
      expect(visiblePanelKeys(allOpen as unknown as LayoutSlice, order)).toEqual(order);
    });

    it('ignores keys that are not panels', () => {
      store.setState({ panelOrder: ['chat', 'ghost-panel'] });
      expect(visiblePanelKeys(store.getState())).toEqual(['chat']);
    });
  });
});

/**
 * Where the three panels a fresh workspace opens with actually sit, and which one gives way.
 *
 * The order list does both jobs: it places the open panels left to right, and `pickEvictionTarget`
 * walks it from the right to decide what closes when a fourth is opened. So "chat and preview lead"
 * and "a third panel does not replace preview" are the same fact stated twice, and the second is the
 * one that was wrong before: with preview last among the visible three, opening the Inspector or the
 * editor took the preview away.
 */
describe('the panels a fresh workspace opens with', () => {
  let store: ReturnType<typeof createLayoutStore>;

  beforeEach(() => {
    for (const key of Object.keys(mockLocalStorage)) delete mockLocalStorage[key];
    store = createLayoutStore();
  });

  it('are chat, preview and files, in that order', () => {
    // Asserted through visiblePanelKeys rather than the raw order, because that is what the
    // workspace renders from: the order also carries panels that start closed.
    expect(visiblePanelKeys(store.getState())).toEqual(['chat', 'preview', 'files']);
  });

  it('gives up files, not preview, to make room for a fourth', () => {
    const open = visiblePanelKeys(store.getState());
    const panels = store.getState().panelOrder.map((key) => ({ key, open: open.includes(key) }));

    expect(pickEvictionTarget(panels, 'editor')).toBe('files');
    expect(pickEvictionTarget(panels, 'checkpoints')).toBe('files');
  });

  it('keeps preview for the Inspector, which needs it, and still takes files', () => {
    const open = visiblePanelKeys(store.getState());
    const panels = store.getState().panelOrder.map((key) => ({ key, open: open.includes(key) }));

    expect(pickEvictionTarget(panels, 'elements')).toBe('files');
  });

  it('leaves a saved order alone, so an existing arrangement is not rearranged', () => {
    mockLocalStorage['osw-workspace-panel-order'] = JSON.stringify(
      ['chat', 'files', 'editor', 'skills', 'console', 'preview', 'elements', 'checkpoints', 'debug'],
    );
    store.getState().initLayout();

    expect(visiblePanelKeys(store.getState())).toEqual(['chat', 'files', 'preview']);
  });
});
