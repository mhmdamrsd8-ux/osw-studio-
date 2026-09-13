import { StateCreator } from 'zustand';

type MobilePanelType = 'chat' | 'files' | 'editor' | 'preview' | 'elements' | 'checkpoints' | 'console' | 'skills' | 'debug';

/**
 * Left to right, for whichever panels are open.
 *
 * Chat and preview lead because they are the pair that stays open: the work is asking for a change
 * and looking at the result, and everything else is opened to answer a question and closed again.
 * Order decides eviction as well as position, since `pickEvictionTarget` walks from the right, so
 * putting them first is what makes a third panel take the third slot instead of replacing preview.
 *
 * Only the default. A saved order wins (`loadPanelOrder`), so this changes nothing for anyone who
 * already has one.
 */
const DEFAULT_PANEL_ORDER = ['chat', 'preview', 'files', 'editor', 'skills', 'console', 'elements', 'checkpoints', 'debug'];

export interface LayoutSlice {
  showChat: boolean;
  showFiles: boolean;
  showEditor: boolean;
  showPreview: boolean;
  showCheckpoints: boolean;
  showConsole: boolean;
  showSkillsPanel: boolean;
  showDebugPanel: boolean;
  showElements: boolean;
  showProjectSettingsModal: boolean;
  /**
   * A section of the project settings dialog to bring into view once it opens, or null.
   *
   * Cleared by the dialog after it scrolls, so opening the dialog again by any other route does not
   * jump to whatever was last requested.
   */
  projectSettingsSection: string | null;
  fullscreenPreview: boolean;
  panelOrder: string[];
  draggingPanel: string | null;
  dropTarget: number | null;
  panelReplacePreview: string | null;
  panelInsertPreview: number | null;
  activeMobilePanel: MobilePanelType;
  mobileOverflowOpen: boolean;
  hasUnreadConsole: boolean;
  placedBlocks: any[];
  paletteOpen: boolean;
  /**
   * In the store (not useState) because both the preview crosshair and the Inspector's
   * Select element button need to read and write it.
   */
  focusToolArmed: boolean;
  /**
   * Hint for the crosshair tint while hovering the Select element button.
   * Cleared on press, unmount, and leave.
   */
  focusToolHinted: boolean;

  togglePanel: (panel: string) => void;
  setPanelOrder: (order: string[]) => void;
  setActiveMobilePanel: (panel: MobilePanelType) => void;
  startDrag: (panel: string) => void;
  endDrag: () => void;
  setDropTarget: (target: number | null) => void;
  setFullscreenPreview: (v: boolean) => void;
  setShowProjectSettingsModal: (v: boolean, section?: string) => void;
  clearProjectSettingsSection: () => void;
  setHasUnreadConsole: (v: boolean) => void;
  setPaletteOpen: (v: boolean) => void;
  setMobileOverflowOpen: (v: boolean) => void;
  setPanelReplacePreview: (panel: string | null) => void;
  setPanelInsertPreview: (idx: number | null) => void;
  setFocusToolArmed: (armed: boolean) => void;
  setFocusToolHinted: (hinted: boolean) => void;
  initLayout: () => void;
  resetLayout: () => void;
}

function loadSavedPanels(): Record<string, boolean> | null {
  try {
    const stored = localStorage.getItem('osw-workspace-panels');
    return stored ? JSON.parse(stored) : null;
  } catch { return null; }
}

function loadPanelOrder(): string[] {
  try {
    const stored = localStorage.getItem('osw-workspace-panel-order');
    if (stored) {
      const parsed = JSON.parse(stored);
      const all = new Set(DEFAULT_PANEL_ORDER);
      const ordered = parsed.filter((k: string) => all.has(k));
      for (const k of DEFAULT_PANEL_ORDER) {
        if (!ordered.includes(k)) ordered.push(k);
      }
      return ordered;
    }
  } catch {}
  return [...DEFAULT_PANEL_ORDER];
}

function persistPanels(state: LayoutSlice) {
  try {
    localStorage.setItem('osw-workspace-panels', JSON.stringify({
      chat: state.showChat, files: state.showFiles, editor: state.showEditor,
      preview: state.showPreview, checkpoints: state.showCheckpoints,
      debug: state.showDebugPanel, skills: state.showSkillsPanel,
      console: state.showConsole, elements: state.showElements,
    }));
  } catch {}
}

function persistPanelOrder(order: string[]) {
  try {
    localStorage.setItem('osw-workspace-panel-order', JSON.stringify(order));
  } catch {}
}

export const PANEL_MAP: Record<string, keyof LayoutSlice> = {
  chat: 'showChat', files: 'showFiles', editor: 'showEditor', console: 'showConsole',
  preview: 'showPreview', elements: 'showElements', checkpoints: 'showCheckpoints',
  debug: 'showDebugPanel', skills: 'showSkillsPanel',
};

/** Elements needs Preview open; opening Elements must not evict Preview. */
const PANEL_COMPANION: Record<string, string> = { elements: 'preview' };

/** Single panel registry; visibility derived from it. */
export function visiblePanelKeys(state: LayoutSlice, order: string[] = state.panelOrder): string[] {
  return order.filter(k => {
    const flag = PANEL_MAP[k];
    return flag ? !!state[flag] : false;
  });
}

/**
 * Which open panel to close to make room for `opening`, walking from the right. Returns null when
 * there is nothing to evict. `opening`'s companion (see PANEL_COMPANION) is passed over unless it
 * is the only candidate left, in which case taking it beats refusing to open the panel at all.
 */
export function pickEvictionTarget(panels: { key: string; open: boolean }[], opening: string): string | null {
  const companion = PANEL_COMPANION[opening];
  for (let i = panels.length - 1; i >= 0; i--) {
    if (panels[i].open && panels[i].key !== opening && panels[i].key !== companion) return panels[i].key;
  }
  for (let i = panels.length - 1; i >= 0; i--) {
    if (panels[i].open && panels[i].key !== opening) return panels[i].key;
  }
  return null;
}

export const createLayoutSlice: StateCreator<LayoutSlice> = (set, get) => {
  const saved = loadSavedPanels();

  return {
    showChat: saved?.chat ?? true,
    showFiles: saved?.files ?? true,
    showEditor: saved?.editor ?? false,
    showPreview: saved?.preview ?? true,
    showCheckpoints: saved?.checkpoints ?? false,
    showConsole: saved?.console ?? false,
    showSkillsPanel: saved?.skills ?? false,
    showDebugPanel: saved?.debug ?? false,
    showElements: saved?.elements ?? false,
    showProjectSettingsModal: false,
    projectSettingsSection: null,
    fullscreenPreview: false,
    panelOrder: loadPanelOrder(),
    draggingPanel: null,
    dropTarget: null,
    panelReplacePreview: null,
    panelInsertPreview: null,
    activeMobilePanel: 'preview',
    mobileOverflowOpen: false,
    hasUnreadConsole: false,
    placedBlocks: [],
    paletteOpen: false,
    focusToolArmed: false,
    focusToolHinted: false,

    togglePanel: (panel: string) => {
      const key = PANEL_MAP[panel];
      if (!key) return;
      const state = get();
      const isOpen = !!state[key];

      if (isOpen) {
        // Closing — always allowed
        const patch: Partial<LayoutSlice> = { [key]: false, panelReplacePreview: null, panelInsertPreview: null };
        set(patch as any);
        persistPanels({ ...state, ...patch } as LayoutSlice);
        return;
      }

      // Opening — check max 3 visible constraint
      const allPanels = state.panelOrder
        .filter(k => PANEL_MAP[k] !== undefined)
        .map(k => ({ key: k, open: !!state[PANEL_MAP[k] as keyof LayoutSlice] }));
      const visibleCount = allPanels.filter(p => p.open).length;

      const MAX_VISIBLE_PANELS = 3;
      let newOrder = state.panelOrder;
      const patch: Partial<LayoutSlice> = { [key]: true, panelReplacePreview: null, panelInsertPreview: null };

      if (visibleCount >= MAX_VISIBLE_PANELS) {
        // Close the rightmost evictable panel and insert new one at its position
        const closedKey = pickEvictionTarget(allPanels, panel);
        if (closedKey) {
          const closedPanelKey = PANEL_MAP[closedKey] as keyof LayoutSlice;
          (patch as any)[closedPanelKey] = false;
          // Move the new panel to the closed panel's position in order
          newOrder = newOrder.filter(k => k !== panel);
          const insertIdx = newOrder.indexOf(closedKey);
          if (insertIdx >= 0) {
            newOrder.splice(insertIdx, 0, panel);
          } else {
            newOrder.push(panel);
          }
        }
      } else {
        // Room available — open as the rightmost panel
        newOrder = newOrder.filter(k => k !== panel);
        newOrder.push(panel);
      }

      patch.panelOrder = newOrder;
      set(patch as any);
      persistPanels({ ...state, ...patch } as LayoutSlice);
      persistPanelOrder(newOrder);
    },

    setPanelOrder: (order: string[]) => {
      set({ panelOrder: order });
      persistPanelOrder(order);
    },

    setActiveMobilePanel: (panel) => set({ activeMobilePanel: panel, mobileOverflowOpen: false }),

    startDrag: (panel: string) => set({ draggingPanel: panel }),
    endDrag: () => set({ draggingPanel: null, dropTarget: null }),
    setDropTarget: (target) => set({ dropTarget: target }),
    setFullscreenPreview: (v) => set({ fullscreenPreview: v }),
    setShowProjectSettingsModal: (v, section) =>
      set({ showProjectSettingsModal: v, projectSettingsSection: v ? section ?? null : null }),
    clearProjectSettingsSection: () => set({ projectSettingsSection: null }),
    setHasUnreadConsole: (v) => set({ hasUnreadConsole: v }),
    setPaletteOpen: (v) => set({ paletteOpen: v }),
    setMobileOverflowOpen: (v) => set({ mobileOverflowOpen: v }),
    setPanelReplacePreview: (panel) => set({ panelReplacePreview: panel }),
    setPanelInsertPreview: (idx) => set({ panelInsertPreview: idx }),
    setFocusToolArmed: (armed) => set({ focusToolArmed: armed }),
    setFocusToolHinted: (hinted) => set({ focusToolHinted: hinted }),

    initLayout: () => {
      set({ panelOrder: loadPanelOrder() });
    },

    resetLayout: () => {
      set({
        draggingPanel: null,
        dropTarget: null,
        panelReplacePreview: null,
        panelInsertPreview: null,
        mobileOverflowOpen: false,
        showProjectSettingsModal: false,
        fullscreenPreview: false,
        paletteOpen: false,
        focusToolArmed: false,
        focusToolHinted: false,
      });
    },
  };
};
