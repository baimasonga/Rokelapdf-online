'use client';
import { openPdf } from '@/components/editor/pdfjs';
import type { ImageInput } from '@/lib/tools/ops';

// Browser-only conversions between PDF pages and images. Everything runs locally with pdf.js and <canvas>.

/** Canvas limits that every current browser can allocate. */
const MAX_SIDE = 10_000;
const MAX_PIXELS = 50_000_000;

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The image could not be created.'))), type, quality));
}

export interface RenderedImage {
  name: string;
  blob: Blob;
}

/** Renders the chosen pages (zero-based) to JPG or PNG at `dpi`. Very large pages are scaled down to fit the canvas. */
export async function pdfToImages(
  bytes: Uint8Array,
  opts: { pages: number[]; format: 'jpeg' | 'png'; dpi: number; quality: number; baseName: string },
  onProgress?: (done: number, total: number) => void,
): Promise<RenderedImage[]> {
  const doc = await openPdf(bytes);
  try {
    const out: RenderedImage[] = [];
    const ext = opts.format === 'jpeg' ? 'jpg' : 'png';
    for (const [k, i] of opts.pages.entries()) {
      const page = await doc.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      let scale = opts.dpi / 72;
      scale = Math.min(scale, MAX_SIDE / base.width, MAX_SIDE / base.height, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Your browser could not create an image.');
      // JPG has no transparency: paint the paper white first.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
      out.push({
        name: `${opts.baseName}-page-${i + 1}.${ext}`,
        blob: await toBlob(canvas, `image/${opts.format}`, opts.format === 'jpeg' ? opts.quality : undefined),
      });
      canvas.width = canvas.height = 0; // release memory early
      page.cleanup();
      onProgress?.(k + 1, opts.pages.length);
    }
    return out;
  } finally {
    void doc.destroy();
  }
}

/**
 * Prepares an image file for embedding. JPG and PNG are used as they are; anything else the browser can decode
 * (WebP, GIF, BMP, AVIF…) is redrawn as PNG.
 */
export async function imageForPdf(file: File): Promise<ImageInput> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type === 'image/jpeg' || file.type === 'image/png') return { bytes, type: file.type };
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: file.type }));
  } catch {
    throw new Error(`“${file.name}” is not an image this browser can read.`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d')?.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await toBlob(canvas, 'image/png');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/png' };
}
