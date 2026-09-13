// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VIEW_CHANGED_EVENT, emitViewChanged, readLocalStudioView, writeLocalStudioView } from '@/lib/view-mode-event';

/**
 * Where browser mode keeps the choice between the studio and the simple view, and how a change
 * reaches the chrome.
 *
 * Server mode holds this on the account row, so it arrives with the server render and the client
 * only has to be told when it changes. Browser mode has no account: the device is the record, and
 * the announcement is the only thing that repaints a sidebar and a settings pane that were rendered
 * before the press.
 *
 * Both halves are built to carry on with no error when storage refuses reads and writes, as it does
 * in a private window, and that is the half worth pinning: nothing downstream would report it.
 */

function listen() {
  const seen: Event[] = [];
  const handler = (e: Event) => seen.push(e);
  window.addEventListener(VIEW_CHANGED_EVENT, handler);
  return { seen, stop: () => window.removeEventListener(VIEW_CHANGED_EVENT, handler) };
}

/** Make storage behave the way a private window does: every access throws. */
function breakStorage() {
  const proto = Object.getPrototypeOf(window.localStorage);
  const getItem = vi.spyOn(proto, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  const setItem = vi.spyOn(proto, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  return { getItem, setItem };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reading the view off the device', () => {
  it('is the studio for a device that has never chosen', () => {
    expect(readLocalStudioView()).toBe(true);
  });

  it('is the simple view once that has been chosen', () => {
    localStorage.setItem('osw-studio-view', 'simple');

    expect(readLocalStudioView()).toBe(false);
  });

  it('is the studio once that has been chosen back', () => {
    localStorage.setItem('osw-studio-view', 'studio');

    expect(readLocalStudioView()).toBe(true);
  });

  it('is the studio for a stored value it does not recognise', () => {
    // Anything but the simple view reads as the studio, so a half-written or hand-edited value
    // cannot strand someone in the cut-down chrome with no menu to leave it by.
    localStorage.setItem('osw-studio-view', 'sImPle-ish');

    expect(readLocalStudioView()).toBe(true);
  });

  it('is the studio when storage refuses to be read', () => {
    const spies = breakStorage();

    expect(readLocalStudioView()).toBe(true);
    // Asserted, because a test that passes without the read ever happening would pass for a
    // function that returns a constant.
    expect(spies.getItem).toHaveBeenCalled();
  });
});

describe('writing the view to the device', () => {
  it('records the simple view', () => {
    writeLocalStudioView(false);

    expect(localStorage.getItem('osw-studio-view')).toBe('simple');
    expect(readLocalStudioView()).toBe(false);
  });

  it('records the studio', () => {
    writeLocalStudioView(false);
    writeLocalStudioView(true);

    expect(localStorage.getItem('osw-studio-view')).toBe('studio');
    expect(readLocalStudioView()).toBe(true);
  });

  it('announces the change, which is what repaints chrome already on screen', () => {
    const { seen, stop } = listen();

    writeLocalStudioView(false);
    stop();

    expect(seen).toHaveLength(1);
  });

  it('still announces the change when storage refuses the write', () => {
    // The choice cannot outlast the page, but it has to take effect on this one: without the
    // announcement the setting would read as having done nothing at all.
    breakStorage();
    const { seen, stop } = listen();

    writeLocalStudioView(false);
    stop();

    expect(seen).toHaveLength(1);
  });
});

describe('announcing a change made elsewhere', () => {
  it('is what the server-mode path uses, having written the account instead', () => {
    const { seen, stop } = listen();

    emitViewChanged();
    stop();

    expect(seen).toHaveLength(1);
  });

  it('reaches every listener, since more than one surface reads the view', () => {
    const a = listen();
    const b = listen();

    emitViewChanged();
    a.stop();
    b.stop();

    expect([a.seen.length, b.seen.length]).toEqual([1, 1]);
  });
});
