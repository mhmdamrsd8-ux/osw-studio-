/**
 * Pure decision logic for the large-file-write pacing notice.
 *
 * On models without tool streaming, a long single-file write makes the UI spin
 * for tens of seconds with nothing visibly happening. This helper decides when
 * to show a calm reassurance banner: a WRITE tool call that has been in progress
 * longer than the threshold, unless the notice has been permanently dismissed.
 *
 * Kept free of the command classifier's import graph: the caller supplies the
 * isWrite predicate so this stays trivially testable.
 */
export interface PacingToolItem {
  type: string;
  timestamp: number;
  status?: string;
  name?: string;
  command?: string;
}

export function shouldShowPacingNotice(
  items: PacingToolItem[],
  now: number,
  dismissed: boolean,
  isWrite: (item: PacingToolItem) => boolean,
  thresholdMs = 30_000,
): boolean {
  if (dismissed) return false;
  return items.some(it =>
    it.type === 'tool'
    && (it.status === 'pending' || it.status === 'executing')
    && isWrite(it)
    && (now - it.timestamp) > thresholdMs
  );
}
