// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ViewModeProvider, useStudioView } from '@/components/view-mode-provider';
import { emitViewChanged, writeLocalStudioView } from '@/lib/view-mode-event';

/**
 * How the chrome learns which view it is rendering, and when.
 *
 * The *when* is the point. The simple view exists for someone who should not be shown the developer
 * menu, so a provider that settled on the answer in an effect would render the full menu for a frame
 * on every page load -- which is most of what they would notice. Both modes therefore answer on the
 * first render: server mode from the value the server put in the props, browser mode by reading the
 * device.
 *
 * The tests assert the *first* value each consumer saw rather than the value it settled on, because
 * a provider that corrects itself one render later passes every assertion about the final state.
 */

let container: HTMLDivElement;
let root: Root;

/** Records what `useStudioView` returned on every render, first included. */
function probe(seen: boolean[]) {
  return function Probe() {
    seen.push(useStudioView());
    return null;
  };
}

function render(node: React.ReactNode) {
  act(() => { root.render(node); });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('without a provider', () => {
  it('is the studio, which is what every surface older than the simple view expects', () => {
    const seen: boolean[] = [];
    const Probe = probe(seen);
    render(<Probe />);

    expect(seen).toEqual([true]);
  });
});

describe('browser mode, where the device is the record', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'false'); });

  it('renders the simple view from the first render, never the studio first', () => {
    localStorage.setItem('osw-studio-view', 'simple');
    const seen: boolean[] = [];
    const Probe = probe(seen);

    render(<ViewModeProvider initialStudioView={null}><Probe /></ViewModeProvider>);

    // The whole assertion is the first element: reading the device in an effect instead would make
    // this [true, false], which is the frame of full chrome the simple view exists to avoid.
    expect(seen[0]).toBe(false);
    expect(seen).not.toContain(true);
  });

  it('renders the studio for a device that has not chosen', () => {
    const seen: boolean[] = [];
    const Probe = probe(seen);

    render(<ViewModeProvider initialStudioView={null}><Probe /></ViewModeProvider>);

    expect(seen[0]).toBe(true);
  });

  it('ignores the prop, which server mode fills and browser mode has no account for', () => {
    localStorage.setItem('osw-studio-view', 'simple');
    const seen: boolean[] = [];
    const Probe = probe(seen);

    render(<ViewModeProvider initialStudioView={true}><Probe /></ViewModeProvider>);

    expect(seen[0]).toBe(false);
  });

  it('follows a change made from the settings pane without a reload', () => {
    const seen: boolean[] = [];
    const Probe = probe(seen);
    render(<ViewModeProvider initialStudioView={null}><Probe /></ViewModeProvider>);
    expect(seen[seen.length - 1]).toBe(true);

    act(() => { writeLocalStudioView(false); });

    expect(seen[seen.length - 1]).toBe(false);
  });

  it('stops listening once it is gone', () => {
    // The evidence is the re-read, not the state. A retained listener sets state on an unmounted
    // tree, which renders nothing and which React does not report, so a consumer cannot see the
    // leak at all -- but the handler still runs, and in browser mode running it means reading the
    // device. That read is observable, and it is what would go on happening once per stranded
    // handler for the life of the page.
    const getItem = vi.spyOn(Object.getPrototypeOf(window.localStorage), 'getItem');

    const Probe = probe([]);
    render(<ViewModeProvider initialStudioView={null}><Probe /></ViewModeProvider>);
    act(() => { root.unmount(); });

    // Cleared after unmount so only what happens next counts. Asserting the live provider reads at
    // all is the control: without it this would pass for a provider that never listened.
    expect(getItem).toHaveBeenCalled();
    getItem.mockClear();

    act(() => { emitViewChanged(); });

    expect(getItem).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});

describe('server mode, where the account is the record', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true'); });

  it('renders the view the server already looked up, on the first render', () => {
    const seen: boolean[] = [];
    const Probe = probe(seen);

    render(<ViewModeProvider initialStudioView={false}><Probe /></ViewModeProvider>);

    expect(seen[0]).toBe(false);
    expect(seen).not.toContain(true);
  });

  it('does not read the device, which holds another install\'s choice', () => {
    localStorage.setItem('osw-studio-view', 'simple');
    const seen: boolean[] = [];
    const Probe = probe(seen);

    render(<ViewModeProvider initialStudioView={true}><Probe /></ViewModeProvider>);

    expect(seen[0]).toBe(true);
  });

  it('re-reads the account when told the view changed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { studioView: false } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const seen: boolean[] = [];
    const Probe = probe(seen);
    render(<ViewModeProvider initialStudioView={true}><Probe /></ViewModeProvider>);

    await act(async () => { emitViewChanged(); });

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me');
    expect(seen[seen.length - 1]).toBe(false);
  });

  it('keeps what the server said when the re-read fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const seen: boolean[] = [];
    const Probe = probe(seen);
    render(<ViewModeProvider initialStudioView={false}><Probe /></ViewModeProvider>);

    await act(async () => { emitViewChanged(); });

    // Falling back to the studio here would hand the developer menu to someone who should not see
    // it, on nothing worse than a dropped request.
    expect(seen[seen.length - 1]).toBe(false);
  });
});
