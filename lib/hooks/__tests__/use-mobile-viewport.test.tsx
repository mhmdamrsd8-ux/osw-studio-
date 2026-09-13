// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMobileViewport } from '@/lib/hooks/use-mobile-viewport';

/**
 * Which of the workspace's two trees is the one on screen.
 *
 * Both are mounted at once and CSS hides one (`hidden md:flex` against `flex md:hidden`), so nothing
 * in React knows which is visible. The Inspector has to: its frame plumbing resolves a preview
 * instance, and addressing the hidden tree's iframe means querying a frame that may not have laid
 * out. This hook is that answer, which is why the boundary it switches on has to be the same one the
 * CSS uses -- a hook that disagreed by a pixel would send the replies to the wrong tree in exactly
 * the window where it matters.
 *
 * The stub below evaluates the media query against a width rather than returning a fixed answer, so
 * these assert where the switch happens and not how the query is spelled.
 */

let container: HTMLDivElement;
let root: Root;

type Listener = () => void;
let listeners: Listener[] = [];
let removed = 0;
let viewportWidth = 0;

/**
 * A matchMedia that answers for the current viewport width.
 *
 * jsdom implements no media queries at all, so without this every test would read the same answer
 * whatever the hook asked -- which is the control in the first test.
 *
 * `matches` is a getter over a mutable width rather than a fixed value, so `resizeTo` can change
 * the answer without re-stubbing. Re-stubbing would discard the subscription the hook already made,
 * and a resize test that fired an empty listener list passed on the first render's value alone.
 */
function stubMatchMedia(width: number) {
  listeners = [];
  removed = 0;
  viewportWidth = width;
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    return {
      get matches() { return max ? viewportWidth <= Number(max[1]) : false; },
      media: query,
      addEventListener: (_type: string, fn: Listener) => { listeners.push(fn); },
      removeEventListener: () => { removed += 1; },
    };
  });
}

/** Change the width and fire the hook's own subscription, as the browser would. */
function resizeTo(width: number) {
  viewportWidth = width;
  act(() => { listeners.forEach((fn) => fn()); });
}

/** Records what the hook reported on every render. */
function probe(seen: boolean[]) {
  return function Probe() {
    seen.push(useMobileViewport());
    return null;
  };
}

function render(width: number) {
  stubMatchMedia(width);
  const seen: boolean[] = [];
  const Probe = probe(seen);
  act(() => { root.render(<Probe />); });
  return seen;
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the stub', () => {
  it('answers from the width, which is what makes the cases below different', () => {
    stubMatchMedia(500);
    expect(window.matchMedia('(max-width: 767.98px)').matches).toBe(true);
    stubMatchMedia(1000);
    expect(window.matchMedia('(max-width: 767.98px)').matches).toBe(false);
  });
});

describe('which tree is on screen', () => {
  it('is the mobile one on a phone', () => {
    expect(render(390).pop()).toBe(true);
  });

  it('is the desktop one on a laptop', () => {
    expect(render(1440).pop()).toBe(false);
  });

  it('switches at the same width the CSS does', () => {
    // Tailwind's `md` applies from 768px up, so 767 is the mobile tree and 768 is not. Asserted as
    // the pair, because either alone passes for a hook that is off by a breakpoint.
    expect(render(767).pop()).toBe(true);
    act(() => { root.unmount(); });
    root = createRoot(container);
    expect(render(768).pop()).toBe(false);
  });

  it('assumes desktop on the first render, even on a phone', () => {
    // Deliberate, and the hook says so: reading matchMedia synchronously would make the client's
    // first render disagree with the static prerender of `/`, which is a hydration mismatch. The
    // cost is that the answer is wrong for one render, so a consumer must not read it during the
    // initial render -- the current ones only read it inside handlers a person triggers.
    //
    // Pinned so that making it synchronous is a decision someone takes on purpose rather than a
    // change that quietly starts mismatching hydration.
    const seen = render(390);

    expect(seen[0]).toBe(false);
    expect(seen[seen.length - 1]).toBe(true);
  });
});

describe('when the window is resized', () => {
  it('follows the change', () => {
    const seen = render(390);
    expect(seen[seen.length - 1]).toBe(true);
    // The control: without a subscription there is nothing to fire, and the assertion below would
    // read the first render's `false` and pass for a hook that never listened.
    expect(listeners).toHaveLength(1);

    resizeTo(1440);

    expect(seen[seen.length - 1]).toBe(false);
  });

  it('stops listening once the consumer is gone', () => {
    render(390);
    expect(listeners).toHaveLength(1);

    act(() => { root.unmount(); });

    expect(removed).toBe(1);
    root = createRoot(container);
  });
});
