import type { PendingImage } from '@/lib/llm/multi-agent-orchestrator';

/**
 * A pending image from a data URL, for the composer.
 *
 * Every image the composer takes, whether picked, pasted, dropped or captured from the preview,
 * comes through here, so the split between the media type and the base64 payload happens once.
 */
export function pendingImageFromDataUrl(dataUrl: string): PendingImage {
  const comma = dataUrl.indexOf(',');
  const header = comma === -1 ? dataUrl : dataUrl.slice(0, comma);
  const data = comma === -1 ? '' : dataUrl.slice(comma + 1);
  const mediaType = header.match(/^data:([^;,]+)/)?.[1] || 'image/png';
  return {
    id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    data,
    mediaType,
    preview: dataUrl,
  };
}
