import html2canvas from 'html2canvas';
import { domToCanvas } from 'modern-screenshot';
import { logger } from '@/lib/utils';
import { TOOLBAR_HOST_ATTR } from '@/lib/preview/toolbar-dom';

/** Removes the toolbar and selection outline from a cloned document before capture. */
export function prepareScreenshotClone(clonedDoc: Document): void {
  // The selection toolbar lives inside the previewed document and stays *visible* for as long as an
  // element is selected — the selection overlay hides itself on selection, this does not. Without
  // this, selecting an element and then capturing bakes the toolbar into the saved thumbnail.
  const toolbars = clonedDoc.querySelectorAll(`[${TOOLBAR_HOST_ATTR}]`);
  toolbars.forEach((el) => el.remove());

  // Remove external stylesheets that cause CORS errors
  const externalLinks = clonedDoc.querySelectorAll('link[rel="stylesheet"]');
  externalLinks.forEach((link) => {
    const href = link.getAttribute('href');
    if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
      link.remove();
    }
  });

  // Remove ALL gradient backgrounds (not just ones with "gradient" in class name)
  // Tailwind gradients can cause "non-finite" errors in html2canvas
  const allElements = clonedDoc.querySelectorAll('*');

  // CRITICAL: Use cloned document's window for getComputedStyle, not parent window
  const clonedWindow = clonedDoc.defaultView;
  if (!clonedWindow) {
    return;
  }

  allElements.forEach((el: Element) => {
    const htmlEl = el as HTMLElement;
    // Read styles from CLONED document's context
    const computedStyle = clonedWindow.getComputedStyle(htmlEl);
    const bg = computedStyle.backgroundImage;

    // Check if element has a gradient background
    if (bg && (bg.includes('gradient') || bg.includes('linear-gradient') || bg.includes('radial-gradient'))) {
      // Replace gradient with solid color from gradient's first color if possible
      // or use a neutral fallback
      const bgColor = computedStyle.backgroundColor;
      htmlEl.style.backgroundImage = 'none';
      if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') {
        htmlEl.style.backgroundColor = bgColor;
      } else {
        htmlEl.style.backgroundColor = '#64748b'; // slate-500 as neutral fallback
      }
    }
  });
}

/**
 * Waits for document resources (fonts, images, idle) to finish loading.
 * All resource promises race against a timeout to prevent indefinite blocking.
 * @param doc The document to wait on
 * @param minDelay Minimum delay in ms regardless of resource readiness (default: 2000)
 * @param timeout Maximum time to wait for resources in ms (default: 8000)
 */
export async function waitForResources(doc: Document, minDelay = 2000, timeout = 8000): Promise<void> {
  const win = doc.defaultView;

  const resourcePromises: Promise<unknown>[] = [
    // Minimum buffer delay
    new Promise(resolve => setTimeout(resolve, minDelay)),
  ];

  // Wait for fonts
  if (doc.fonts?.ready) {
    resourcePromises.push(doc.fonts.ready.catch(() => {}));
  }

  // Wait for all <img> elements to load
  const images = doc.querySelectorAll('img');
  images.forEach((img) => {
    if (!img.complete) {
      resourcePromises.push(
        new Promise<void>(resolve => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        })
      );
    }
  });

  // Wait for idle callback (indicates browser has finished layout/paint work)
  if (win) {
    resourcePromises.push(
      new Promise<void>(resolve => {
        if ('requestIdleCallback' in win) {
          (win as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
            .requestIdleCallback(() => resolve(), { timeout: 500 });
        } else {
          setTimeout(resolve, 500);
        }
      })
    );
  }

  // Race all resource promises against timeout
  await Promise.race([
    Promise.all(resourcePromises),
    new Promise(resolve => setTimeout(resolve, timeout)),
  ]);
}

const RENDER_TIMEOUT_MS = 6000;

/**
 * Paint the document with the browser's own engine.
 *
 * The page is serialised into an SVG `foreignObject` and drawn to a canvas, so whatever the preview
 * can display, the capture can too: `oklch` colours, gradients interpolated in `oklab`, `color-mix`.
 * html2canvas repaints CSS in JavaScript and has none of those, which is why it turned this site's
 * gradients into slate. Same-origin assets inline as they are; a hot-linked image needs CORS to
 * appear, as it did before.
 */
async function renderWithBrowser(
  iframeDoc: Document,
  captureWidth: number,
  height: number,
): Promise<HTMLCanvasElement> {
  // The page is painted as it is laid out, at the frame's own width. html2canvas could relayout a
  // clone at a requested width; a serialised document cannot, and asking for a wider canvas only
  // adds a white gutter beside the page. A frame narrower than the requested width is painted at
  // up to twice its size instead, so the output does not have to be stretched to reach it.
  const width = Math.max(iframeDoc.documentElement.clientWidth, iframeDoc.body.scrollWidth, 1);
  const scale = width < captureWidth ? Math.min(2, captureWidth / width) : 1;
  const canvas = await domToCanvas(iframeDoc.documentElement, {
    width,
    height,
    scale,
    backgroundColor: '#ffffff',
    timeout: 3000,
    // The selection toolbar lives inside the previewed document and stays visible while an element
    // is selected; it is not part of the page.
    filter: (node) => !(node instanceof Element && node.hasAttribute(TOOLBAR_HOST_ATTR)),
  });
  if (canvas.width === 0 || canvas.height === 0) throw new Error('empty canvas');
  return canvas;
}

/**
 * Internal function to attempt screenshot capture
 */
async function attemptCapture(
  iframeDoc: Document,
  captureWidth: number,
  captureHeight: number,
  fullPage: boolean
): Promise<HTMLCanvasElement> {
  // Determine capture height based on mode
  let effectiveHeight: number;

  if (fullPage) {
    // Get actual document height for full-page capture
    effectiveHeight = Math.max(
      iframeDoc.body.scrollHeight,
      iframeDoc.body.offsetHeight,
      iframeDoc.documentElement.clientHeight,
      iframeDoc.documentElement.scrollHeight,
      iframeDoc.documentElement.offsetHeight
    );
    logger.debug('[Screenshot] Full-page mode: document height =', effectiveHeight);
  } else {
    // Use viewport height for initial view capture
    effectiveHeight = captureHeight;
    logger.debug('[Screenshot] Viewport-only mode: using height =', effectiveHeight);
  }

  logger.debug('[Screenshot] Capture dimensions:', captureWidth, 'x', effectiveHeight);

  // The browser's own painter first; html2canvas, with its clone-time flattening, only when that
  // fails outright, which is what an engine without dependable foreignObject rendering looks like.
  try {
    return await Promise.race([
      renderWithBrowser(iframeDoc, captureWidth, effectiveHeight),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`foreignObject render timeout after ${RENDER_TIMEOUT_MS}ms`)), RENDER_TIMEOUT_MS)
      ),
    ]);
  } catch (error) {
    logger.warn('[Screenshot] Browser render failed, falling back to html2canvas:', error);
  }

  return Promise.race([
    html2canvas(iframeDoc.body, {
        width: captureWidth,
        height: effectiveHeight,
        scale: 1,
        useCORS: true,
        allowTaint: true,
        logging: false,
        windowWidth: captureWidth,
        windowHeight: effectiveHeight,
        scrollX: 0,
        scrollY: 0,
        imageTimeout: 3000,
        backgroundColor: '#ffffff',
        removeContainer: true,
        // Clean up problematic elements in the cloned document
        onclone: prepareScreenshotClone
      }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('html2canvas timeout after 4 seconds')), 4000)
    )
  ]);
}

export async function captureIframeScreenshot(
  iframe: HTMLIFrameElement,
  captureWidth: number = 1280,
  captureHeight: number = 720,
  outputWidth: number = 640,
  // Unused: the output height follows the captured aspect ratio, not a requested one.
  _outputHeight: number = 360,
  quality: number = 0.8,
  fullPage: boolean = true,
  waitForContent: boolean = false,
  minWaitDelay: number = 1500
): Promise<string | null> {
  try {
    // Get the iframe's document
    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;

    if (!iframeDoc || !iframeDoc.body) {
      logger.warn('Cannot access iframe document');
      return null;
    }

    // Wait for resources if requested
    if (waitForContent) {
      try {
        await waitForResources(iframeDoc, minWaitDelay);
      } catch {
        // Fall back to simple delay if resource waiting fails
        await new Promise(resolve => setTimeout(resolve, minWaitDelay));
      }
    }

    // Attempt capture with automatic retry on gradient errors
    let canvas: HTMLCanvasElement;
    try {
      canvas = await attemptCapture(iframeDoc, captureWidth, captureHeight, fullPage);
    } catch (firstError) {
      // Check if this is a gradient-related error
      const errorMsg = String(firstError);
      if (errorMsg.includes('non-finite') || errorMsg.includes('addColorStop') || errorMsg.includes('CanvasGradient')) {
        // Wait a bit for styles to stabilize further
        await new Promise(resolve => setTimeout(resolve, 500));
        canvas = await attemptCapture(iframeDoc, captureWidth, captureHeight, fullPage);
      } else {
        // Not a gradient error, rethrow
        throw firstError;
      }
    }

    // Scale down the captured image maintaining aspect ratio
    // Never wider than what was painted: a narrow frame gives a narrow, sharp image, not a
    // stretched one.
    const targetWidth = Math.min(outputWidth, canvas.width);
    const aspectRatio = canvas.height / canvas.width;
    const scaledHeight = Math.round(targetWidth * aspectRatio);

    const scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = targetWidth;
    scaledCanvas.height = scaledHeight;
    const ctx = scaledCanvas.getContext('2d');

    if (!ctx) {
      logger.error('Failed to get canvas context');
      return null;
    }

    // Draw the captured image scaled down maintaining aspect ratio
    ctx.drawImage(canvas, 0, 0, targetWidth, scaledHeight);

    // Convert scaled canvas to base64 JPEG
    const dataUrl = scaledCanvas.toDataURL('image/jpeg', quality);

    // Validate size (max 250KB)
    const sizeInBytes = Math.ceil((dataUrl.length * 3) / 4);
    const sizeInKB = sizeInBytes / 1024;

    if (sizeInKB > 250) {
      logger.warn(`Screenshot too large: ${sizeInKB.toFixed(0)}KB, trying with lower quality`);
      // Retry with lower quality using scaled canvas
      const retryDataUrl = scaledCanvas.toDataURL('image/jpeg', 0.6);
      const retrySizeInKB = Math.ceil((retryDataUrl.length * 3) / 4) / 1024;

      if (retrySizeInKB > 250) {
        logger.warn(`Screenshot still too large: ${retrySizeInKB.toFixed(0)}KB`);
        return retryDataUrl; // Return anyway, let VFS handle size limit
      }

      return retryDataUrl;
    }

    return dataUrl;

  } catch (error) {
    logger.error('Failed to capture screenshot:', error);
    return null;
  }
}
