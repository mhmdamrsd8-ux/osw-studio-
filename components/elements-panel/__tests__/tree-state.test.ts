import { describe, it, expect } from 'vitest';
import {
  describeUnavailable,
  emptyTreeState,
  flattenTree,
  reduceTree,
  type TreeState,
} from '../index';
import type { TreeNode } from '@/lib/preview/types';

/**
 * The Elements panel's logic, tested where it lives: as plain functions over state.
 *
 * There is no React Testing Library in this repo, so a rendering test would be a test of a mock.
 * `reduceTree` and `flattenTree` are the panel — the component holds a `useState` and forwards
 * gestures to them — so everything worth asserting is reachable here. What is *not* covered:
 * `useImperativeHandle` actually being called by the workspace's props, and the row markup. Those
 * are the manual pass's job.
 */

function node(id: string, over: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    tag: 'div',
    file: '/index.hbs',
    line: Number(id),
    instances: 1,
    hasChildren: false,
    ...over,
  };
}

/** Root level, then whatever further levels are given, applied in order. */
function build(levels: { parentId: string | null; nodes: TreeNode[]; truncated?: number }[]): TreeState {
  let state = emptyTreeState();
  for (const level of levels) {
    state = reduceTree(state, {
      type: 'level',
      parentId: level.parentId,
      nodes: level.nodes,
      truncated: level.truncated ?? 0,
    }).state;
  }
  return state;
}

describe('reduceTree', () => {
  it('asks for the body level when the frame announces a load', () => {
    const { state, requests } = reduceTree(emptyTreeState(), { type: 'frame-ready' });
    expect(requests).toEqual([{ type: 'tree-request', nodeId: null }]);
    expect(state.children.size).toBe(0);
  });

  it('drops every id from the previous document when the frame reloads', () => {
    const before = build([
      { parentId: null, nodes: [node('1', { hasChildren: true })] },
      { parentId: '1', nodes: [node('2')] },
    ]);
    const expandedBefore = reduceTree(before, { type: 'toggle', nodeId: '1' }).state;
    expect(expandedBefore.expanded.has('1')).toBe(true);

    const { state } = reduceTree(expandedBefore, { type: 'frame-ready' });
    expect(state.nodes.size).toBe(0);
    expect(state.expanded.size).toBe(0);
    expect(state.selectedId).toBeNull();
  });

  it('collapses to root and re-requests it when the frame reports a stale id', () => {
    const before = build([{ parentId: null, nodes: [node('1', { hasChildren: true })] }]);
    const selected = reduceTree(before, { type: 'select', nodeId: '1' }).state;

    const { state, requests } = reduceTree(selected, { type: 'stale' });
    expect(state.nodes.size).toBe(0);
    expect(state.selectedId).toBeNull();
    expect(requests).toEqual([{ type: 'tree-request', nodeId: null }]);
  });

  it('rebuilds the whole tree from a second body level rather than merging into the old one', () => {
    const before = build([
      { parentId: null, nodes: [node('1', { hasChildren: true })] },
      { parentId: '1', nodes: [node('2')] },
    ]);
    const state = build([
      { parentId: null, nodes: [node('1', { hasChildren: true })] },
      { parentId: '1', nodes: [node('2')] },
      { parentId: null, nodes: [node('7', { tag: 'main' })] },
    ]);
    expect(before.nodes.has('2')).toBe(true);
    expect([...state.nodes.keys()]).toEqual(['7']);
    expect(state.children.get(null)).toEqual(['7']);
    expect(state.children.has('1')).toBe(false);
  });

  it('ignores a level whose parent it has never heard of', () => {
    const before = build([{ parentId: null, nodes: [node('1')] }]);
    const { state } = reduceTree(before, { type: 'level', parentId: '99', nodes: [node('100')], truncated: 0 });
    expect(state).toBe(before);
    expect(state.nodes.has('100')).toBe(false);
  });

  it('collapses a branch whose level comes back empty and takes its caret away', () => {
    const loaded = build([{ parentId: null, nodes: [node('1', { hasChildren: true })] }]);
    const expanded = reduceTree(loaded, { type: 'toggle', nodeId: '1' }).state;

    const { state } = reduceTree(expanded, { type: 'level', parentId: '1', nodes: [], truncated: 0 });
    expect(state.expanded.has('1')).toBe(false);
    expect(state.nodes.get('1')!.hasChildren).toBe(false);
    expect(state.children.has('1')).toBe(false);
    // The row survives — the element may well still be there; only the promise of children is gone.
    expect(flattenTree(state).map(r => r.kind)).toEqual(['node']);
  });

  it('requests a level the first time a node is expanded and never again', () => {
    const loaded = build([{ parentId: null, nodes: [node('1', { hasChildren: true })] }]);

    const first = reduceTree(loaded, { type: 'toggle', nodeId: '1' });
    expect(first.requests).toEqual([{ type: 'tree-request', nodeId: '1' }]);

    const withLevel = reduceTree(first.state, { type: 'level', parentId: '1', nodes: [node('2')], truncated: 0 }).state;
    const collapsed = reduceTree(withLevel, { type: 'toggle', nodeId: '1' });
    expect(collapsed.requests).toEqual([]);
    expect(collapsed.state.expanded.has('1')).toBe(false);

    const reopened = reduceTree(collapsed.state, { type: 'toggle', nodeId: '1' });
    expect(reopened.requests).toEqual([]);
    expect(reopened.state.expanded.has('1')).toBe(true);
  });

  it('does not request or select an id it does not hold', () => {
    const loaded = build([{ parentId: null, nodes: [node('1')] }]);
    expect(reduceTree(loaded, { type: 'toggle', nodeId: '404' }).requests).toEqual([]);
    const selection = reduceTree(loaded, { type: 'select', nodeId: '404' });
    expect(selection.requests).toEqual([]);
    expect(selection.state.selectedId).toBeNull();
  });

  it('sends tree-select for a click and remembers what is selected', () => {
    const loaded = build([{ parentId: null, nodes: [node('1'), node('2')] }]);
    const { state, requests } = reduceTree(loaded, { type: 'select', nodeId: '2' });
    expect(requests).toEqual([{ type: 'tree-select', nodeId: '2' }]);
    expect(state.selectedId).toBe('2');
  });

  it('sends tree-highlight on hover and a null one on leave, holding no highlight state', () => {
    const loaded = build([{ parentId: null, nodes: [node('1')] }]);
    const hover = reduceTree(loaded, { type: 'hover', nodeId: '1' });
    expect(hover.requests).toEqual([{ type: 'tree-highlight', nodeId: '1' }]);
    expect(hover.state).toBe(loaded);

    const leave = reduceTree(hover.state, { type: 'hover', nodeId: null });
    expect(leave.requests).toEqual([{ type: 'tree-highlight', nodeId: null }]);
  });

  it('re-requests the body level on an explicit refresh', () => {
    const loaded = build([{ parentId: null, nodes: [node('1')] }]);
    const { state, requests } = reduceTree(loaded, { type: 'refresh' });
    expect(requests).toEqual([{ type: 'tree-request', nodeId: null }]);
    expect(state.nodes.size).toBe(0);
  });

  describe('reveal', () => {
    const levels = [
      { parentId: null, nodes: [node('1', { hasChildren: true }), node('9')], truncated: 0 },
      { parentId: '1', nodes: [node('2', { hasChildren: true })], truncated: 0 },
      { parentId: '2', nodes: [node('3')], truncated: 0 },
    ];

    it('opens every ancestor of the revealed node and selects it', () => {
      const { state } = reduceTree(emptyTreeState(), { type: 'reveal', levels, path: ['1', '2', '3'] });
      expect(state.selectedId).toBe('3');
      // The ancestors open; the node itself is a leaf here and is not expanded.
      expect([...state.expanded].sort()).toEqual(['1', '2']);
      expect(state.nodes.has('3')).toBe(true);
    });

    it('puts the revealed node on screen, which is the point of it', () => {
      const { state } = reduceTree(emptyTreeState(), { type: 'reveal', levels, path: ['1', '2', '3'] });
      expect(flattenTree(state).filter((r) => r.kind === 'node').map((r) => r.node.id)).toEqual(['1', '2', '3', '9']);
    });

    it('asks the frame for nothing: the levels it needs already came with the reply', () => {
      const { requests } = reduceTree(emptyTreeState(), { type: 'reveal', levels, path: ['1', '2', '3'] });
      expect(requests).toEqual([]);
    });

    it('leaves the tree alone when the frame could not resolve the node', () => {
      const before = build([{ parentId: null, nodes: [node('1')] }]);
      const { state } = reduceTree(before, { type: 'reveal', levels: [], path: [] });
      expect(state).toBe(before);
    });

    it('replaces what the panel held rather than merging into it', () => {
      // A tree from a document that has since been replaced. Merging would leave its rows behind.
      const stale = build([{ parentId: null, nodes: [node('77'), node('78')] }]);
      const { state } = reduceTree(stale, { type: 'reveal', levels, path: ['1', '2', '3'] });
      expect(state.nodes.has('77')).toBe(false);
      expect(state.children.get(null)).toEqual(['1', '9']);
    });

    it('keeps the truncation count for a level that came back capped', () => {
      const capped = [{ parentId: null, nodes: [node('1', { hasChildren: true })], truncated: 12 }];
      const { state } = reduceTree(emptyTreeState(), { type: 'reveal', levels: capped, path: ['1'] });
      expect(state.truncated.get(null)).toBe(12);
    });
  });

});

describe('flattenTree', () => {
  it('emits only the levels that are expanded, indented by depth', () => {
    const loaded = build([
      { parentId: null, nodes: [node('1', { hasChildren: true }), node('9', { tag: 'footer' })] },
      { parentId: '1', nodes: [node('2', { hasChildren: true })] },
      { parentId: '2', nodes: [node('3')] },
    ]);
    const expanded: TreeState = { ...loaded, expanded: new Set(['1', '2']) };

    expect(flattenTree(expanded).map(r => (r.kind === 'node' ? `${r.depth}:${r.node.id}` : r.kind)))
      .toEqual(['0:1', '1:2', '2:3', '0:9']);

    const collapsed: TreeState = { ...loaded, expanded: new Set(['1']) };
    expect(flattenTree(collapsed).map(r => (r.kind === 'node' ? `${r.depth}:${r.node.id}` : r.kind)))
      .toEqual(['0:1', '1:2', '0:9']);
  });

  it('shows a level as loading while its request is outstanding', () => {
    const loaded = build([{ parentId: null, nodes: [node('1', { hasChildren: true })] }]);
    const expanded = reduceTree(loaded, { type: 'toggle', nodeId: '1' }).state;
    const rows = flattenTree(expanded);
    expect(rows.map(r => r.kind)).toEqual(['node', 'loading']);
    expect(rows[1]).toMatchObject({ kind: 'loading', parentId: '1', depth: 1 });
  });

  it('reports how many siblings the serializer dropped, at the level they were dropped from', () => {
    const loaded = build([
      { parentId: null, nodes: [node('1', { hasChildren: true })], truncated: 4 },
      { parentId: '1', nodes: [node('2')], truncated: 300 },
    ]);
    const expanded: TreeState = { ...loaded, expanded: new Set(['1']) };
    const rows = flattenTree(expanded);
    expect(rows.map(r => r.kind)).toEqual(['node', 'node', 'truncated', 'truncated']);
    expect(rows[2]).toMatchObject({ kind: 'truncated', parentId: '1', count: 300, depth: 1 });
    expect(rows[3]).toMatchObject({ kind: 'truncated', parentId: null, count: 4, depth: 0 });
  });

  it('marks the selected row and only that row', () => {
    const loaded = build([{ parentId: null, nodes: [node('1'), node('2')] }]);
    const selected = reduceTree(loaded, { type: 'select', nodeId: '2' }).state;
    const rows = flattenTree(selected);
    expect(rows.map(r => r.kind === 'node' && r.selected)).toEqual([false, true]);
  });
});

describe('describeUnavailable', () => {
  it('says there is nothing to inspect without a project', () => {
    expect(describeUnavailable({ hasProject: false, previewOpen: true, runtime: 'handlebars' }))
      .toBe('no-project');
  });

  it('names the runtime before the preview, because opening a terminal preview would not help', () => {
    expect(describeUnavailable({ hasProject: true, previewOpen: false, runtime: 'python' }))
      .toBe('terminal-runtime');
    expect(describeUnavailable({ hasProject: true, previewOpen: true, runtime: 'lua' }))
      .toBe('terminal-runtime');
  });

  it('reports every bundled runtime as unsupported rather than showing an empty tree', () => {
    for (const runtime of ['react', 'preact', 'svelte', 'vue'] as const) {
      expect(describeUnavailable({ hasProject: true, previewOpen: true, runtime }))
        .toBe('bundled-runtime');
    }
  });

  it('reports a closed preview, which is the one the user can fix', () => {
    expect(describeUnavailable({ hasProject: true, previewOpen: false, runtime: 'static' }))
      .toBe('preview-closed');
  });

  it('lets the tree run for the runtimes that emit provenance', () => {
    expect(describeUnavailable({ hasProject: true, previewOpen: true, runtime: 'handlebars' })).toBeNull();
    expect(describeUnavailable({ hasProject: true, previewOpen: true, runtime: 'static' })).toBeNull();
  });
});
