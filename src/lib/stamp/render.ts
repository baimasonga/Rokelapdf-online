import { PT_PER_MM, stampDate, stampNumber, type StampDesign } from './design';
import { inkify, rng } from './ink';

// Draws a stamp design on a canvas, gives it real ink (ink.ts) and a small hand tilt, and returns it as a PNG with a
// transparent background. Each call is a fresh impression: pass a new seed every time the stamp is used.

export interface Impression {
  /** PNG data URL, made on this device. */
  src: string;
  /** Width / height of the picture (the tilt included). */
  aspect: number;
  /** Width of the picture on paper, in PDF points. */
  widthPt: number;
}

const FONT = '"Inter Variable", Inter, Arial, Helvetica, sans-serif';

type Ctx = CanvasRenderingContext2D;

function setFont(ctx: Ctx, weight: number, px: number, spacing = 0) {
  ctx.font = `${weight} ${px}px ${FONT}`;
  if ('letterSpacing' in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = `${spacing}px`;
}

/** The largest size (≤ max) at which `text` fits in `width`. */
function fit(ctx: Ctx, text: string, weight: number, max: number, width: number, spacing = 0): number {
  let px = max;
  for (; px > 10; px -= 2) {
    setFont(ctx, weight, px, spacing * (px / max));
    if (ctx.measureText(text).width <= width) break;
  }
  return px;
}

/** Text along a circle: centred on the top (upright, reading clockwise) or the bottom (upright, reading left to right). */
function arcText(ctx: Ctx, text: string, cx: number, cy: number, r: number, where: 'top' | 'bottom', maxPx: number, maxSpan: number) {
  if (!text) return;
  let px = maxPx;
  let widths: number[] = [];
  let span = 0;
  for (; px > 12; px -= 2) {
    setFont(ctx, 800, px, 0);
    widths = [...text].map((ch) => ctx.measureText(ch).width + px * 0.08);
    span = widths.reduce((a, b) => a + b, 0) / r;
    if (span <= maxSpan) break;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const chars = [...text];
  let a = where === 'top' ? -Math.PI / 2 - span / 2 : Math.PI / 2 + span / 2;
  chars.forEach((ch, i) => {
    const step = widths[i]! / r;
    a += where === 'top' ? step / 2 : -step / 2;
    ctx.save();
    ctx.translate(cx + r * Math.cos(a), cy + r * Math.sin(a));
    ctx.rotate(where === 'top' ? a + Math.PI / 2 : a - Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    a += where === 'top' ? step / 2 : -step / 2;
  });
}

/** The lines in the middle of a stamp: the design's own words, then the date and the number when switched on. */
function centreLines(d: StampDesign, date: Date, number: number): Array<{ text: string; weight: number; scale: number; spacing: number }> {
  const out: Array<{ text: string; weight: number; scale: number; spacing: number }> = [];
  for (const line of d.middle
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean))
    out.push({ text: line, weight: 800, scale: 1, spacing: 2 });
  if (d.date) out.push({ text: stampDate(date), weight: 800, scale: 0.9, spacing: 4 });
  if (d.numbered) out.push({ text: stampNumber(number), weight: 700, scale: 0.7, spacing: 2 });
  return out;
}

function drawRound(ctx: Ctx, d: StampDesign, date: Date, number: number) {
  const S = 640;
  const c = S / 2;
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.arc(c, c, 300, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(c, c, 228, 0, Math.PI * 2);
  ctx.stroke();
  const both = !!d.top && !!d.bottom;
  arcText(ctx, d.top.toUpperCase(), c, c, 262, 'top', 46, both ? Math.PI * 0.82 : Math.PI * 1.6);
  arcText(ctx, d.bottom.toUpperCase(), c, c, 262, 'bottom', 40, both ? Math.PI * 0.7 : Math.PI * 1.6);
  if (both) {
    setFont(ctx, 800, 34);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', c - 262, c);
    ctx.fillText('★', c + 262, c);
  }
  const lines = centreLines(d, date, number);
  if (!lines.length) return;
  const sizes = lines.map((l, i) =>
    fit(ctx, l.text, l.weight, (lines.length > 2 ? 56 : 68) * l.scale, 360 - Math.abs(i - (lines.length - 1) / 2) * 40, l.spacing),
  );
  const total = sizes.reduce((a, b) => a + b * 1.15, 0);
  let y = c - total / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    const px = sizes[i]!;
    setFont(ctx, l.weight, px, l.spacing * (px / 60));
    ctx.fillText(l.text, c, y + (px * 1.15) / 2);
    y += px * 1.15;
  });
}

function drawBoxed(ctx: Ctx, oval: boolean, W: number, H: number) {
  ctx.lineWidth = 14;
  ctx.beginPath();
  if (oval) ctx.ellipse(W / 2, H / 2, W / 2 - 12, H / 2 - 12, 0, 0, Math.PI * 2);
  else ctx.roundRect(10, 10, W - 20, H - 20, 22);
  ctx.stroke();
  ctx.lineWidth = 5;
  ctx.beginPath();
  if (oval) ctx.ellipse(W / 2, H / 2, W / 2 - 40, H / 2 - 40, 0, 0, Math.PI * 2);
  else ctx.roundRect(34, 34, W - 68, H - 68, 12);
  ctx.stroke();
}

function boxedLines(d: StampDesign, date: Date, number: number) {
  const lines: Array<{ text: string; weight: number; px: number; spacing: number }> = [];
  if (d.top) lines.push({ text: d.top.toUpperCase(), weight: 900, px: 130, spacing: 10 });
  for (const l of centreLines(d, date, number)) lines.push({ text: l.text, weight: l.weight, px: 64 * l.scale, spacing: l.spacing * 2 });
  if (d.bottom) lines.push({ text: d.bottom.toUpperCase(), weight: 700, px: 40, spacing: 4 });
  return lines;
}

/** Draws the design flat (no ink effect) in its ink colour; returns the canvas. */
export function drawFlat(d: StampDesign, date: Date, number: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  if (d.shape === 'round') {
    canvas.width = canvas.height = 640;
    ctx.fillStyle = ctx.strokeStyle = d.ink;
    drawRound(ctx, d, date, number);
    return canvas;
  }
  const oval = d.shape === 'oval';
  const W = 1000;
  const lines = boxedLines(d, date, number);
  // Measure every line at a size that fits inside the frame.
  canvas.width = W;
  canvas.height = 10;
  const inner = oval ? W - 260 : W - 120;
  const sizes = lines.map((l) => fit(ctx, l.text, l.weight, l.px, inner, l.spacing));
  const textH = sizes.reduce((a, b) => a + b * 1.18, 0);
  const H = Math.max(oval ? 480 : 260, Math.round(textH + (oval ? 200 : 110)));
  canvas.height = H;
  ctx.fillStyle = ctx.strokeStyle = d.ink;
  drawBoxed(ctx, oval, W, H);
  let y = (H - textH) / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    const px = sizes[i]!;
    setFont(ctx, l.weight, px, l.spacing * (px / l.px));
    ctx.fillText(l.text, W / 2, y + (px * 1.18) / 2);
    y += px * 1.18;
  });
  return canvas;
}

/** One impression of the stamp: inked, tilted a little, as a PNG data URL. */
export function renderStamp(d: StampDesign, o: { seed: number; date?: Date; number?: number; tilt?: number }): Impression {
  const flat = drawFlat(d, o.date ?? new Date(), o.number ?? d.next);
  const ctx = flat.getContext('2d')!;
  const img = ctx.getImageData(0, 0, flat.width, flat.height);
  inkify(img.data, flat.width, flat.height, { seed: o.seed, wear: d.wear });
  ctx.putImageData(img, 0, 0);
  // A hand never stamps perfectly straight.
  const tilt = ((o.tilt ?? (rng(o.seed ^ 0x51ed27)() - 0.5) * 7) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(tilt));
  const sin = Math.abs(Math.sin(tilt));
  const out = document.createElement('canvas');
  out.width = Math.ceil(flat.width * cos + flat.height * sin);
  out.height = Math.ceil(flat.width * sin + flat.height * cos);
  const octx = out.getContext('2d')!;
  octx.translate(out.width / 2, out.height / 2);
  octx.rotate(tilt);
  octx.drawImage(flat, -flat.width / 2, -flat.height / 2);
  // Keep the file small: the stamp is shown at a few centimetres.
  const k = Math.min(1, 520 / Math.max(out.width, out.height));
  let final = out;
  if (k < 1) {
    final = document.createElement('canvas');
    final.width = Math.round(out.width * k);
    final.height = Math.round(out.height * k);
    final.getContext('2d')!.drawImage(out, 0, 0, final.width, final.height);
  }
  return { src: final.toDataURL('image/png'), aspect: final.width / final.height, widthPt: d.sizeMm * PT_PER_MM * (out.width / flat.width) };
}
