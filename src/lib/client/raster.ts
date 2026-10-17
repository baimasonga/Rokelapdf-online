'use client';
import { closePdf, openPdf } from '@/components/editor/pdfjs';
import type { ImageInput, ImageRecoder } from '@/lib/tools/ops';

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
    void closePdf(doc);
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

/**
 * Re-encodes one image from a PDF for "Compress PDF": decode (the browser's JPEG decoder, or raw pixels), scale to
 * fit `maxSide`, and encode as JPEG. Returns undefined when this browser cannot decode the image.
 */
export const browserRecoder: ImageRecoder = async (img, { maxSide, quality }) => {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * k));
  const height = Math.max(1, Math.round(img.height * k));
  let source: CanvasImageSource;
  let release = () => undefined as void;
  if (img.kind === 'jpeg') {
    try {
      const bmp = await createImageBitmap(new Blob([img.bytes as BlobPart], { type: 'image/jpeg' }));
      source = bmp;
      release = () => bmp.close();
    } catch {
      return undefined;
    }
  } else {
    const full = document.createElement('canvas');
    full.width = img.width;
    full.height = img.height;
    const data = new ImageData(img.width, img.height);
    const px = img.pixels;
    for (let i = 0, j = 0; i < img.width * img.height; i++, j += 4) {
      const o = i * img.channels;
      data.data[j] = px[o]!;
      data.data[j + 1] = px[img.channels === 3 ? o + 1 : o]!;
      data.data[j + 2] = px[img.channels === 3 ? o + 2 : o]!;
      data.data[j + 3] = 255;
    }
    full.getContext('2d')!.putImageData(data, 0, 0);
    source = full;
    release = () => void (full.width = full.height = 0);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  release();
  const blob = await toBlob(canvas, 'image/jpeg', quality);
  canvas.width = canvas.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
};
