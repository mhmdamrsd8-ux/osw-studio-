import { describe, it, expect } from 'vitest';
import { pendingImageFromDataUrl } from '@/lib/llm/pending-image';

describe('pendingImageFromDataUrl', () => {
  it('splits the media type from the payload and keeps the whole URL as the preview', () => {
    const image = pendingImageFromDataUrl('data:image/jpeg;base64,AAAA');
    expect(image.mediaType).toBe('image/jpeg');
    expect(image.data).toBe('AAAA');
    expect(image.preview).toBe('data:image/jpeg;base64,AAAA');
    expect(image.id).toMatch(/^img-/);
  });

  it('falls back to png when the header names no type', () => {
    expect(pendingImageFromDataUrl('data:;base64,BBBB').mediaType).toBe('image/png');
  });

  it('gives two images different ids', () => {
    expect(pendingImageFromDataUrl('data:image/png;base64,A').id).not.toBe(pendingImageFromDataUrl('data:image/png;base64,A').id);
  });
});
