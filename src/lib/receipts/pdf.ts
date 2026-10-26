import {
  BlendMode,
  PDFDocument,
  StandardFonts,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSpacing,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import { dataUrlBytes } from '../editor/export';
import { encodeQr } from '../qr';
import { drawableText } from '../editor/model';
import {
  amountInWords,
  docNumber,
  isSlip,
  lineAmount,
  longDate,
  money,
  TITLES,
  totals,
  type BizDoc,
  type Business,
  type Currency,
  type DocKind,
  type Totals,
} from './model';

// Lays out a business document (receipt, invoice, proforma) as a real PDF: selectable text, small files, A4 or A5,
// in the "receipt book" style (a printed carbon book filled in in blue) or the "modern" style (clean page, the
// business's colours). Runs in the browser and in tests; nothing is uploaded.

const SIZES = { A4: [595.28, 841.89], A5: [419.53, 595.28] } as const;
const MM = 72 / 25.4;
/** Paper width and the printable width of common thermal printers (72 mm on 80 mm rolls, 48 mm on 58 mm rolls). */
const SLIPS = { '80mm': [80 * MM, 72 * MM], '58mm': [58 * MM, 48 * MM] } as const;
const INK = rgb(0.133, 0.204, 0.541); // ballpoint blue, the "filled in" text of the receipt book
const RED = rgb(0.776, 0.157, 0.157);
const MUTED = rgb(0.38, 0.43, 0.52);
const TEXT = rgb(0.06, 0.12, 0.24);
const LINE = rgb(0.9, 0.91, 0.94);
const WHITE = rgb(1, 1, 1);

function hex(c: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim());
  if (!m) return rgb(0.07, 0.19, 0.42);
  return rgb(parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255);
}
/** The colour mixed with white: tint(c, 0.08) is a pale wash of c. */
const tint = (c: RGB, k: number) => rgb(1 - (1 - c.red) * k, 1 - (1 - c.green) * k, 1 - (1 - c.blue) * k);
const t = (s: string) =>
  drawableText(s ?? '')
    .replace(/\n/g, ' ')
    .trim();

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  mono: PDFFont;
}

/**
 * Drawing helper with a top-left origin, so layouts read top to bottom. A `dry` canvas draws nothing: layouts run on
 * one to measure how tall a section will be before deciding where it goes.
 */
class Canvas {
  constructor(
    readonly page: PDFPage,
    readonly f: Fonts,
    readonly dry = false,
  ) {}
  get W() {
    return this.page.getWidth();
  }
  get H() {
    return this.page.getHeight();
  }
  text(s: string, x: number, y: number, o: { size: number; font?: PDFFont; color?: RGB; align?: 'left' | 'right' | 'center'; spacing?: number }) {
    const font = o.font ?? this.f.regular;
    const str = t(s);
    if (!str) return 0;
    const sp = o.spacing ?? 0;
    const w = font.widthOfTextAtSize(str, o.size) + sp * str.length;
    const dx = o.align === 'right' ? -w : o.align === 'center' ? -w / 2 : 0;
    if (this.dry) return w;
    if (sp) this.page.pushOperators(pushGraphicsState(), setCharacterSpacing(sp));
    this.page.drawText(str, { x: x + dx, y: this.H - y - o.size * 0.8, size: o.size, font, color: o.color ?? TEXT });
    if (sp) this.page.pushOperators(popGraphicsState());
    return w;
  }
  width(s: string, size: number, font = this.f.regular) {
    return font.widthOfTextAtSize(t(s), size);
  }
  /** Splits text into lines no wider than `w`. */
  wrap(s: string, w: number, size: number, font = this.f.regular): string[] {
    const out: string[] = [];
    for (const para of drawableText(s ?? '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= w || !line) line = next;
        else {
          out.push(line);
          line = word;
        }
      }
      if (line) out.push(line);
    }
    return out;
  }
  rect(x: number, y: number, w: number, h: number, o: { fill?: RGB; stroke?: RGB; width?: number; radius?: number; dash?: number[] }) {
    if (this.dry) return;
    if (o.radius) {
      const r = Math.min(o.radius, w / 2, h / 2);
      const path = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
      this.page.drawSvgPath(path, { x, y: this.H - y, color: o.fill, borderColor: o.stroke, borderWidth: o.stroke ? (o.width ?? 1) : 0 });
      return;
    }
    this.page.drawRectangle({
      x,
      y: this.H - y - h,
      width: w,
      height: h,
      color: o.fill,
      borderColor: o.stroke,
      borderWidth: o.stroke ? (o.width ?? 1) : 0,
      borderDashArray: o.dash,
    });
  }
  line(x1: number, y1: number, x2: number, y2: number, o: { color?: RGB; width?: number; dash?: number[] } = {}) {
    if (this.dry) return;
    this.page.drawLine({
      start: { x: x1, y: this.H - y1 },
      end: { x: x2, y: this.H - y2 },
      thickness: o.width ?? 1,
      color: o.color ?? TEXT,
      dashArray: o.dash,
    });
  }
  image(img: PDFImage, x: number, y: number, w: number, o: { multiply?: boolean; maxH?: number } = {}) {
    let h = (w * img.height) / img.width;
    if (o.maxH && h > o.maxH) {
      w = (w * o.maxH) / h;
      h = o.maxH;
    }
    if (this.dry) return { w, h };
    this.page.drawImage(img, { x, y: this.H - y - h, width: w, height: h, ...(o.multiply ? { blendMode: BlendMode.Multiply } : {}) });
    return { w, h };
  }
}

async function embedImage(pdf: PDFDocument, src?: string): Promise<PDFImage | undefined> {
  if (!src) return undefined;
  try {
    const { type, bytes } = dataUrlBytes(src);
    return type === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  } catch {
    return undefined;
  }
}

const initials = (name: string) =>
  t(name)
    .split(/[\s&]+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 3)
    .map((w) => w[0]!.toUpperCase())
    .join('') || 'R';

interface Ctx {
  pdf: PDFDocument;
  f: Fonts;
  biz: Business;
  doc: BizDoc;
  sum: Totals;
  main: RGB;
  accent: RGB;
  logo?: PDFImage;
  signature?: PDFImage;
  stamp?: PDFImage;
  paidStamp?: PDFImage;
  copy: string;
  /** A blank page of a printed receipt book: the layout and number only, filled in by hand. */
  blank?: boolean;
}

const MONEY = (c: Ctx, n: number) => `${c.doc.currency} ${money(n)}`;

/** The labelled rows under the item table, in order; the last is the one that stands out. */
function totalRows(c: Ctx): { rows: Array<[string, number]>; grand: [string, number]; after: Array<[string, number]> } {
  const s = c.sum;
  const extras: Array<[string, number]> = [];
  if (s.discount) extras.push(['Discount', -s.discount]);
  if (s.delivery) extras.push(['Delivery', s.delivery]);
  if (s.gst) extras.push(['GST 15%', s.gst]);
  const rows: Array<[string, number]> = extras.length ? [['Sub-total', s.subtotal], ...extras] : [];
  if (c.doc.kind === 'invoice') return { rows: [...rows, ['Total', s.total], ['Paid', -s.paid]], grand: ['Balance due', s.balance], after: [] };
  if (c.doc.kind === 'receipt')
    return {
      rows,
      grand: ['Total', s.total],
      after: [
        ['Paid', s.paid],
        ['Balance', s.balance],
      ],
    };
  return { rows, grand: ['Total', s.total], after: [] };
}

function signedLabel(c: Ctx) {
  return c.doc.kind === 'receipt' ? 'Received by' : c.doc.kind === 'invoice' ? `For ${t(c.biz.name) || 'the business'}` : 'Authorised signature';
}

// ============================================ modern ====================================================
function modernPage(c: Ctx, cv: Canvas, first: boolean): number {
  const k = cv.W / 595.28;
  const m = 34 * k;
  const small = c.doc.size === 'A5';
  cv.rect(0, 0, cv.W, 5 * k, { fill: c.main });
  const bandH = (small ? 92 : 86) * k;
  cv.rect(0, 5 * k, cv.W, bandH, { fill: tint(c.main, 0.05) });
  // Logo: the business's picture, or its initials on the accent colour.
  const L = 40 * k;
  const ly = 22 * k;
  if (c.logo) cv.image(c.logo, m, ly, L, { maxH: L });
  else {
    cv.rect(m, ly, L, L, { fill: c.accent, radius: 9 * k });
    cv.text(initials(c.biz.name), m + L / 2, ly + L / 2 - 5.5 * k, { size: 12 * k, font: c.f.bold, color: WHITE, align: 'center' });
  }
  cv.text(c.biz.name || 'Your business name', m + L + 10 * k, ly + 3 * k, { size: 15 * k, font: c.f.bold });
  if (c.biz.tagline) cv.text(c.biz.tagline, m + L + 10 * k, ly + 22 * k, { size: 8.5 * k, color: MUTED });
  const contact = [c.biz.address, c.biz.phones, c.biz.email, c.biz.tin && `TIN ${c.biz.tin}`].filter(Boolean) as string[];
  if (small) {
    cv.wrap(contact.join(' · '), cv.W - 2 * m, 7.5 * k)
      .slice(0, 2)
      .forEach((l, i) => cv.text(l, m, ly + L + 6 * k + i * 10 * k, { size: 7.5 * k, color: MUTED }));
  } else contact.forEach((l, i) => cv.text(l, cv.W - m, ly + i * 11 * k, { size: 8.5 * k, color: MUTED, align: 'right' }));
  let y = 5 * k + bandH + 18 * k;
  // Title and the document's numbers.
  const title = TITLES[c.doc.kind].modern + (first ? '' : ' (continued)');
  cv.text(title, m, y, { size: (first ? 26 : 16) * k, font: c.f.bold, color: c.main });
  const meta: Array<[string, string]> = [
    [c.doc.kind === 'receipt' ? 'RECEIPT NO.' : c.doc.kind === 'invoice' ? 'INVOICE NO.' : 'QUOTE NO.', c.doc.number],
    ['DATE', longDate(c.doc.date)],
  ];
  if (c.doc.until) meta.push([c.doc.kind === 'invoice' ? 'DUE' : 'VALID UNTIL', longDate(c.doc.until)]);
  let mx = cv.W - m;
  for (const [label, value] of [...meta].reverse()) {
    const w = Math.max(cv.width(label, 7 * k), cv.width(value, 9.5 * k, c.f.bold));
    cv.text(label, mx - w, y + 4 * k, { size: 7 * k, color: MUTED });
    cv.text(value, mx - w, y + 15 * k, { size: 9.5 * k, font: c.f.bold });
    mx -= w + 16 * k;
  }
  y += (first ? 40 : 30) * k;
  if (!first) return y;
  // Who it is for, and how it was paid or referenced.
  const left: [string, string, string] = [
    c.doc.kind === 'receipt' ? 'RECEIVED FROM' : c.doc.kind === 'invoice' ? 'BILL TO' : 'PREPARED FOR',
    c.doc.customer,
    c.doc.customerDetails,
  ];
  const right: [string, string, string] =
    c.doc.kind === 'receipt'
      ? ['PAID BY', c.doc.method, c.doc.payRef]
      : c.doc.kind === 'invoice'
        ? ['TERMS', c.doc.reference, '']
        : ['YOUR REFERENCE', c.doc.reference, ''];
  const bw = cv.W - 2 * m;
  const colW = bw / 2 - 20 * k;
  const detailLines = (s: string) => cv.wrap(s, colW, 8 * k).slice(0, 3);
  const boxH = 30 * k + Math.max(detailLines(left[2]).length, detailLines(right[2]).length) * 10 * k + 6 * k;
  cv.rect(m, y, bw, boxH, { fill: tint(c.main, 0.05), radius: 9 * k });
  [left, right].forEach(([label, v, d], i) => {
    const x = m + 12 * k + i * (bw / 2);
    cv.text(label, x, y + 10 * k, { size: 7 * k, color: MUTED });
    cv.text(v || '—', x, y + 20 * k, { size: 9.5 * k, font: c.f.bold });
    detailLines(d).forEach((l, j) => cv.text(l, x, y + 32 * k + j * 10 * k, { size: 8 * k, color: MUTED }));
  });
  return y + boxH + 14 * k;
}

function modernTableHead(c: Ctx, cv: Canvas, y: number, cols: number[]) {
  const k = cv.W / 595.28;
  const m = 34 * k;
  const labels = ['ITEM', 'QTY', 'RATE', 'AMOUNT'];
  labels.forEach((l, i) => cv.text(l, i === 0 ? m + 8 * k : cols[i]!, y, { size: 7 * k, color: MUTED, align: i === 0 ? 'left' : 'right' }));
  cv.line(m, y + 13 * k, cv.W - m, y + 13 * k, { color: c.main, width: 1.4 * k });
  return y + 17 * k;
}

function modernTail(c: Ctx, cv: Canvas, y: number) {
  const k = cv.W / 595.28;
  const m = 34 * k;
  const small = c.doc.size === 'A5';
  const tw = (small ? 190 : 220) * k;
  const tx = cv.W - m - tw;
  y += 10 * k;
  const { rows, grand, after } = totalRows(c);
  const row = (label: string, n: number) => {
    cv.text(label, tx + 8 * k, y, { size: 9 * k });
    cv.text(`${n < 0 ? '– ' : ''}${MONEY(c, Math.abs(n))}`, cv.W - m - 8 * k, y, { size: 9 * k, font: c.f.bold, align: 'right' });
    y += 15 * k;
  };
  rows.forEach(([l, n]) => row(l, n));
  const gh = 26 * k;
  const due = c.doc.kind === 'invoice';
  cv.rect(tx, y - 2 * k, tw, gh, { fill: due ? c.accent : c.main, radius: 7 * k });
  cv.text(grand[0], tx + 10 * k, y + 5.5 * k, { size: 11 * k, color: WHITE });
  cv.text(MONEY(c, grand[1]), cv.W - m - 10 * k, y + 5 * k, { size: 12 * k, font: c.f.bold, color: WHITE, align: 'right' });
  y += gh + 6 * k;
  after.forEach(([l, n]) => row(l, n));
  // The amount in words, as on every receipt book.
  cv.wrap(amountInWords(c.doc.kind === 'invoice' ? c.sum.total : grand[1], c.doc.currency), cv.W - 2 * m, 8.5 * k, c.f.italic).forEach((l) => {
    cv.text(l, cv.W - m, y + 2 * k, { size: 8.5 * k, font: c.f.italic, color: MUTED, align: 'right' });
    y += 12 * k;
  });
  // How to pay / terms.
  if (c.doc.notes.trim() && c.doc.kind !== 'receipt') {
    y += 8 * k;
    const lines = cv.wrap(c.doc.notes, cv.W - 2 * m - 30 * k, 8.5 * k);
    const h = 22 * k + lines.length * 11 * k;
    cv.rect(m, y, cv.W - 2 * m, h, { stroke: LINE, radius: 6 * k });
    cv.rect(m, y, 3 * k, h, { fill: c.accent });
    cv.text(c.doc.kind === 'invoice' ? 'HOW TO PAY' : 'TERMS', m + 14 * k, y + 8 * k, { size: 7 * k, color: MUTED });
    lines.forEach((l, i) => cv.text(l, m + 14 * k, y + 19 * k + i * 11 * k, { size: 8.5 * k }));
    y += h;
  }
  return y;
}

// ============================================ receipt book ==============================================
function bookPage(c: Ctx, cv: Canvas, first: boolean): { x0: number; y: number } {
  const k = cv.W / 595.28;
  // The cream of a carbon book, except on blank books, which are printed and should not spend ink on it.
  if (!c.blank) cv.rect(0, 0, cv.W, cv.H, { fill: rgb(0.984, 0.965, 0.91) });
  const stub = c.doc.counterfoil && c.doc.kind === 'receipt';
  const sw = stub ? 92 * k : 0;
  if (stub) {
    if (!c.blank) cv.rect(0, 0, sw, cv.H, { fill: rgb(0.953, 0.918, 0.824) });
    cv.line(sw, 0, sw, cv.H, { color: rgb(0.72, 0.68, 0.56), width: 1.2 * k, dash: [3 * k, 3 * k] });
    const s = 9 * k;
    let y = 24 * k;
    cv.text('No.', 10 * k, y, { size: s, font: c.f.bold, color: c.main });
    cv.text(c.doc.number, 10 * k + cv.width('No. ', s, c.f.bold), y - 1 * k, { size: s * 1.25, font: c.f.mono, color: RED });
    y += 26 * k;
    const stubField = (label: string, value: string) => {
      cv.text(label, 10 * k, y, { size: 8 * k, font: c.f.bold, color: c.main });
      cv.wrap(value, sw - 18 * k, 8 * k)
        .slice(0, 2)
        .forEach((l, i) => cv.text(l, 12 * k, y + 11 * k + i * 10 * k, { size: 8 * k, color: INK }));
      cv.line(10 * k, y + 33 * k, sw - 10 * k, y + 33 * k, { color: rgb(0.5, 0.54, 0.65), width: 0.6 * k, dash: [1 * k, 1.5 * k] });
      y += 42 * k;
    };
    stubField('Date', longDate(c.doc.date));
    stubField('Name', c.doc.customer);
    stubField(
      'For',
      c.doc.lines
        .map((l) => l.item)
        .filter(Boolean)
        .join(', '),
    );
    stubField(c.doc.currency, c.blank ? '' : money(c.sum.total));
  }
  const x0 = sw + 28 * k;
  const x1 = cv.W - 28 * k;
  let y = 26 * k;
  // Letterhead: logo (or initials in a ring), name, line of trade, address and phones.
  const L = 44 * k;
  if (c.logo) cv.image(c.logo, x0, y, L, { maxH: L });
  else {
    cv.page.drawCircle({ x: x0 + L / 2, y: cv.H - y - L / 2, size: L / 2 - 1.2 * k, borderColor: c.main, borderWidth: 2.4 * k });
    cv.text(initials(c.biz.name), x0 + L / 2, y + L / 2 - 5 * k, { size: 11 * k, font: c.f.bold, color: c.main, align: 'center' });
  }
  const nx = x0 + L + 10 * k;
  const nameSize = Math.min(19 * k, ((x1 - nx) / Math.max(1, cv.width((c.biz.name || 'YOUR BUSINESS NAME').toUpperCase(), 1, c.f.bold))) * 0.98);
  cv.text((c.biz.name || 'Your business name').toUpperCase(), nx, y, { size: nameSize, font: c.f.bold, color: c.main });
  let hy = y + nameSize + 3 * k;
  if (c.biz.tagline) {
    cv.text(c.biz.tagline, nx, hy, { size: 8.5 * k, font: c.f.italic, color: c.main });
    hy += 11 * k;
  }
  const contact = [c.biz.address, c.biz.phones && `Tel: ${c.biz.phones}`, c.biz.email, c.biz.tin && `TIN ${c.biz.tin}`].filter(Boolean).join(' · ');
  cv.wrap(contact, x1 - nx, 8 * k)
    .slice(0, 2)
    .forEach((l) => {
      cv.text(l, nx, hy, { size: 8 * k, color: c.main });
      hy += 10 * k;
    });
  y = Math.max(y + L, hy) + 6 * k;
  cv.line(x0, y, x1, y, { color: c.main, width: 1 * k });
  cv.line(x0, y + 2.5 * k, x1, y + 2.5 * k, { color: c.main, width: 1 * k });
  y += 12 * k;
  // Title tab and the red number.
  const title = TITLES[c.doc.kind].book + (first ? '' : ' (CONTINUED)');
  const ts = 9 * k;
  const tw = cv.width(title, ts, c.f.bold) + title.length * 1.2 * k + 22 * k;
  cv.rect(x0, y, tw, 19 * k, { fill: c.main, radius: 9.5 * k });
  cv.text(title, x0 + 11 * k, y + 5 * k, { size: ts, font: c.f.bold, color: WHITE, spacing: 1.2 * k });
  const ns = 13 * k;
  cv.text(c.doc.number, x1, y + 2 * k, { size: ns, font: c.f.mono, color: RED, align: 'right' });
  cv.text('No.', x1 - cv.width(c.doc.number, ns, c.f.mono) - 4 * k, y + 4 * k, { size: 9 * k, font: c.f.bold, color: c.main, align: 'right' });
  y += 30 * k;
  return { x0, y };
}

/** "Label: ……value……" on a dotted line, as printed receipt books do. Returns the height used. */
function field(c: Ctx, cv: Canvas, label: string, value: string, x: number, y: number, w: number) {
  const k = cv.W / 595.28;
  const s = 9 * k;
  const lw = cv.width(label, s, c.f.bold) + 6 * k;
  cv.text(label, x, y, { size: s, font: c.f.bold, color: c.main });
  const lines = cv.wrap(value, w - lw - 4 * k, s, c.f.bold).slice(0, 3);
  (lines.length ? lines : ['']).forEach((l, i) => {
    cv.text(l, x + lw + 2 * k, y + i * 12 * k, { size: s, font: c.f.bold, color: INK });
    cv.line(x + lw, y + 11 * k + i * 12 * k, x + w, y + 11 * k + i * 12 * k, { color: rgb(0.5, 0.54, 0.65), width: 0.6 * k, dash: [1 * k, 1.5 * k] });
  });
  return Math.max(1, lines.length) * 12 * k + 6 * k;
}

function bookFields(c: Ctx, cv: Canvas, x0: number, y: number): number {
  const k = cv.W / 595.28;
  const W = cv.W - 28 * k - x0;
  const half = W / 2 - 8 * k;
  const pairs: Array<Array<[string, string]>> =
    c.doc.kind === 'receipt'
      ? [[['Date', longDate(c.doc.date)]], [['Received from', [c.doc.customer, c.doc.customerDetails].filter(Boolean).join(', ')]]]
      : c.doc.kind === 'invoice'
        ? [
            [
              ['Date', longDate(c.doc.date)],
              ['Due date', longDate(c.doc.until)],
            ],
            [['Bill to', [c.doc.customer, c.doc.customerDetails].filter(Boolean).join(', ')]],
            [['Terms', c.doc.reference]],
          ]
        : [
            [
              ['Date', longDate(c.doc.date)],
              ['Valid until', longDate(c.doc.until)],
            ],
            [['To', [c.doc.customer, c.doc.customerDetails].filter(Boolean).join(', ')]],
            [['Your ref.', c.doc.reference]],
          ];
  for (const row of pairs) {
    const hs = row.map(([l, v], i) => field(c, cv, l, v, x0 + i * (half + 16 * k), y, row.length > 1 ? half : W));
    y += Math.max(...hs);
  }
  return y + 2 * k;
}

function bookCols(c: Ctx, cv: Canvas, x0: number) {
  const k = cv.W / 595.28;
  const x1 = cv.W - 28 * k;
  const num = (c.doc.size === 'A5' ? 64 : 92) * k;
  return { x0, q: x0 + 34 * k, r: x1 - 2 * num, a: x1 - num, x1 };
}

function bookTableHead(c: Ctx, cv: Canvas, x0: number, y: number) {
  const k = cv.W / 595.28;
  const col = bookCols(c, cv, x0);
  const h = 18 * k;
  cv.rect(col.x0, y, col.x1 - col.x0, h, { fill: tint(c.main, 0.08), stroke: c.main, width: 1 * k });
  const labels: Array<[string, number, number]> = [
    ['QTY', col.x0, col.q],
    ['DESCRIPTION', col.q, col.r],
    [`RATE (${c.doc.currency})`, col.r, col.a],
    [`AMOUNT (${c.doc.currency})`, col.a, col.x1],
  ];
  labels.forEach(([l, a, b]) => cv.text(l, (a + b) / 2, y + 5.5 * k, { size: 6.8 * k, font: c.f.bold, color: c.main, align: 'center' }));
  return y + h;
}

function bookRow(c: Ctx, cv: Canvas, x0: number, y: number, line: { qty: number; item: string; rate: number } | undefined) {
  const k = cv.W / 595.28;
  const col = bookCols(c, cv, x0);
  const s = 9 * k;
  const lines = line ? cv.wrap(line.item, col.r - col.q - 10 * k, s, c.f.bold).slice(0, 3) : [''];
  const h = Math.max(19 * k, lines.length * 11 * k + 8 * k);
  for (const x of [col.x0, col.q, col.r, col.a, col.x1]) cv.line(x, y, x, y + h, { color: c.main, width: 1 * k });
  cv.line(col.x0, y + h, col.x1, y + h, { color: rgb(0.62, 0.71, 0.84), width: 0.7 * k });
  if (line) {
    cv.text(String(line.qty), (col.x0 + col.q) / 2, y + 5 * k, { size: s, font: c.f.bold, color: INK, align: 'center' });
    lines.forEach((l, i) => cv.text(l, col.q + 6 * k, y + 5 * k + i * 11 * k, { size: s, font: c.f.bold, color: INK }));
    cv.text(money(line.rate), col.a - 6 * k, y + 5 * k, { size: s, font: c.f.bold, color: INK, align: 'right' });
    cv.text(money(lineAmount(line)), col.x1 - 6 * k, y + 5 * k, { size: s, font: c.f.bold, color: INK, align: 'right' });
  }
  return y + h;
}

function bookTail(c: Ctx, cv: Canvas, x0: number, y: number) {
  const k = cv.W / 595.28;
  const col = bookCols(c, cv, x0);
  cv.line(col.x0, y, col.x1, y, { color: c.main, width: 1 * k });
  const { rows, grand, after } = totalRows(c);
  const all: Array<[string, number, boolean]> = [
    ...rows.map(([l, n]) => [l, n, false] as [string, number, boolean]),
    [grand[0], grand[1], true],
    ...after.map(([l, n]) => [l, n, false] as [string, number, boolean]),
  ];
  for (const [label, n, big] of all) {
    const h = 19 * k;
    cv.rect(col.a, y, col.x1 - col.a, h, { stroke: c.main, width: 1 * k });
    cv.text(`${label.toUpperCase()}${big ? ` ${c.doc.currency}` : ''}`, col.a - 8 * k, y + 5.5 * k, {
      size: 8.5 * k,
      font: c.f.bold,
      color: c.main,
      align: 'right',
    });
    if (!c.blank)
      cv.text(`${n < 0 ? '– ' : ''}${money(Math.abs(n))}`, col.x1 - 6 * k, y + 4.5 * k, {
        size: (big ? 11 : 9.5) * k,
        font: c.f.bold,
        color: big && c.doc.kind !== 'receipt' ? RED : INK,
        align: 'right',
      });
    y += h;
  }
  y += 10 * k;
  const W = col.x1 - col.x0;
  const words = c.blank ? '' : amountInWords(c.doc.kind === 'invoice' ? c.sum.total : grand[1], c.doc.currency);
  y += field(c, cv, 'Amount in words', words, x0, y, W);
  // A blank book leaves room to write the amount on a second line.
  if (c.blank) y += field(c, cv, '', '', x0, y, W);
  if (c.doc.kind === 'receipt') {
    // Payment method tick boxes, as printed in receipt books.
    const s = 8.5 * k;
    let x = x0;
    cv.text('Paid by:', x, y + 1 * k, { size: s, font: c.f.bold, color: c.main });
    x += cv.width('Paid by: ', s, c.f.bold) + 4 * k;
    for (const m of ['Cash', 'Orange Money', 'Afrimoney', 'QMoney', 'Bank transfer', 'Cheque']) {
      const w = 9 * k + 4 * k + cv.width(m, s, c.f.bold) + 10 * k;
      if (x + w > col.x1) {
        x = x0 + cv.width('Paid by: ', s, c.f.bold) + 4 * k;
        y += 13 * k;
      }
      cv.rect(x, y + 0.5 * k, 8 * k, 8 * k, { stroke: c.main, width: 0.8 * k });
      if (c.doc.method === m) {
        cv.line(x + 1.5 * k, y + 4.5 * k, x + 3.5 * k, y + 7 * k, { color: INK, width: 1.4 * k });
        cv.line(x + 3.5 * k, y + 7 * k, x + 7.5 * k, y + 1.5 * k, { color: INK, width: 1.4 * k });
      }
      cv.text(m, x + 12 * k, y + 1 * k, { size: s, font: c.doc.method === m ? c.f.bold : c.f.regular, color: c.doc.method === m ? INK : c.main });
      x += w;
    }
    y += 18 * k;
    if (c.doc.payRef.trim() || c.blank) y += field(c, cv, 'Ref. / Transaction ID', c.doc.payRef, x0, y, W);
  } else if (c.doc.notes.trim()) {
    if (c.doc.kind === 'invoice') y += field(c, cv, 'Pay to', c.doc.notes, x0, y, W);
    else {
      const lines = cv.wrap(`Terms: ${c.doc.notes}`, W - 16 * k, 8.5 * k);
      const h = lines.length * 11 * k + 12 * k;
      cv.rect(x0, y, W, h, { stroke: rgb(0.55, 0.58, 0.66), width: 0.8 * k, dash: [3 * k, 2 * k] });
      lines.forEach((l, i) => cv.text(l, x0 + 8 * k, y + 6 * k + i * 11 * k, { size: 8.5 * k, color: c.main }));
      y += h + 6 * k;
    }
  }
  return y;
}

// ============================================ shared footer =============================================
const footerLines = (c: Ctx, cv: Canvas, x0: number, x1: number) =>
  cv.wrap(c.doc.footer, x1 - x0, (8 * cv.W) / 595.28, c.doc.style === 'book' ? c.f.italic : c.f.regular).slice(0, 3);
const SIGN_H = 96;

/** Space the footer needs below the content: signature block, footer message and copy label. */
function footerHeight(c: Ctx, cv: Canvas, x0: number) {
  const k = cv.W / 595.28;
  const x1 = cv.W - (c.doc.style === 'book' ? 28 : 34) * k;
  return (24 + (c.copy ? 12 : 0) + SIGN_H + 18) * k + footerLines(c, cv, x0, x1).length * 11 * k;
}

/** Signature, stamps, the business's footer message and the copy label, at the bottom of the last page. */
function footer(c: Ctx, cv: Canvas, x0: number, yContent: number) {
  const k = cv.W / 595.28;
  const x1 = cv.W - (c.doc.style === 'book' ? 28 : 34) * k;
  const footLines = footerLines(c, cv, x0, x1);
  const bottom = cv.H - 24 * k - (c.copy ? 12 * k : 0) - footLines.length * 11 * k;
  const signH = SIGN_H * k;
  const sy = Math.max(yContent + 10 * k, bottom - signH - 8 * k);
  // Signature over a line, with the label under it.
  const lw = 170 * k;
  const lineY = sy + signH - 22 * k;
  if (c.signature) cv.image(c.signature, x0 + 4 * k, lineY - 46 * k, 150 * k, { maxH: 44 * k });
  cv.line(x0, lineY, x0 + lw, lineY, { color: c.doc.style === 'book' ? c.main : TEXT, width: 1 * k });
  const under = [c.doc.signedBy.trim(), signedLabel(c)].filter(Boolean).join(' · ');
  cv.text(under, x0, lineY + 4 * k, { size: 8 * k, font: c.f.bold, color: c.doc.style === 'book' ? c.main : TEXT });
  // The business stamp beside the signature, and PAID when the receipt or invoice is settled.
  const stampW = 92 * k;
  if (c.stamp) cv.image(c.stamp, x0 + lw - 30 * k, sy, stampW, { multiply: true, maxH: signH - 4 * k });
  // The receipt check QR code at the right, with the PAID stamp beside it.
  const qrW = c.doc.check ? checkQr(c, cv, x1, sy) : 0;
  const settled = c.doc.kind !== 'proforma' && c.sum.balance <= 0 && c.sum.total > 0;
  if (c.paidStamp && settled) cv.image(c.paidStamp, x1 - qrW - 112 * k, sy + 8 * k, 108 * k, { multiply: true, maxH: signH - 16 * k });
  // Footer message and the copy label.
  let fy = Math.max(lineY + 20 * k, bottom);
  if (c.doc.style === 'modern' && footLines.length) cv.line(x0, fy - 6 * k, x1, fy - 6 * k, { color: LINE, width: 0.8 * k });
  footLines.forEach((l) => {
    cv.text(l, (x0 + x1) / 2, fy, {
      size: 8 * k,
      font: c.doc.style === 'book' ? c.f.italic : c.f.regular,
      color: c.doc.style === 'book' ? c.main : MUTED,
      align: 'center',
    });
    fy += 11 * k;
  });
  if (c.copy) cv.text(c.copy, (x0 + x1) / 2, fy + 2 * k, { size: 6.5 * k, font: c.f.bold, color: rgb(0.54, 0.5, 0.39), align: 'center', spacing: 2 * k });
}

/** Draws a QR code for `url` as a size × size square with its top-left corner at (x, y). */
function drawQr(cv: Canvas, url: string, x: number, y: number, size: number) {
  const qr = encodeQr(url);
  // A quiet zone of 2 modules is enough for phone scanners, and keeps the code large on small paper.
  const cell = size / (qr.size + 4);
  cv.rect(x, y, size, size, { fill: WHITE });
  for (let r = 0; r < qr.size; r++)
    for (let col = 0; col < qr.size; col++)
      if (qr.modules[r]![col]) cv.rect(x + (col + 2) * cell, y + (r + 2) * cell, cell + 0.05, cell + 0.05, { fill: rgb(0, 0, 0) });
}
const spacedCode = (code: string) => code.replace(/(.{4})(?=.)/g, '$1 ');

/** Draws the receipt check QR code with its right edge at x1; returns the width it took, with a gap. */
function checkQr(c: Ctx, cv: Canvas, x1: number, y: number): number {
  const k = cv.W / 595.28;
  const check = c.doc.check!;
  const size = 64 * k;
  drawQr(cv, check.url, x1 - size, y, size);
  cv.text('Scan to check', x1 - size / 2, y + size + 2 * k, { size: 6.5 * k, font: c.f.bold, color: TEXT, align: 'center' });
  cv.text(spacedCode(check.code), x1 - size / 2, y + size + 10 * k, { size: 5.5 * k, font: c.f.regular, color: MUTED, align: 'center' });
  return size + 8 * k;
}

// ============================================ till slip =================================================
/**
 * A till slip for thermal printers: everything in one centred column, black only (thermal paper has no colour), on
 * a page as long as the content. Signatures and stamps are left off; they do not print well on thermal paper.
 */
function drawSlip(c: Ctx) {
  const BLACK = rgb(0, 0, 0);
  const [W, printable] = SLIPS[c.doc.size as keyof typeof SLIPS];
  const tall = 14_400; // the largest page PDF readers accept; trimmed to the content at the end
  const cv = new Canvas(c.pdf.addPage([W, tall]), c.f);
  const k = printable / (72 * MM);
  const m = (W - printable) / 2;
  const x1 = W - m;
  const mid = W / 2;
  const base = 8 * k;
  let y = 12;
  const centre = (s: string, size: number, font = c.f.regular, gap = 1.3) => {
    for (const l of cv.wrap(s, printable, size, font)) {
      cv.text(l, mid, y, { size, font, color: BLACK, align: 'center' });
      y += size * gap;
    }
  };
  const pair = (label: string, value: string, o: { size?: number; bold?: boolean } = {}) => {
    const size = o.size ?? base;
    const font = o.bold ? c.f.bold : c.f.regular;
    const vw = Math.min(cv.width(value, size, font), printable * 0.62);
    const lines = cv.wrap(value, Math.max(vw, printable * 0.3), size, font);
    cv.text(label, m, y, { size, font, color: BLACK });
    lines.forEach((l, i) => cv.text(l, x1, y + i * size * 1.3, { size, font, color: BLACK, align: 'right' }));
    y += Math.max(1, lines.length) * size * 1.3 + 1;
  };
  const rule = () => {
    y += 3;
    cv.line(m, y, x1, y, { color: BLACK, width: 0.6, dash: [2, 2] });
    y += 6;
  };

  if (c.logo) {
    const h = Math.min(36 * k, (printable * 0.4 * c.logo.height) / c.logo.width);
    const w = (h * c.logo.width) / c.logo.height;
    cv.image(c.logo, mid - w / 2, y, w);
    y += h + 5;
  }
  centre(c.biz.name.toUpperCase(), 11 * k, c.f.bold, 1.2);
  if (c.biz.tagline.trim()) centre(c.biz.tagline, base * 0.9, c.f.italic);
  for (const s of [c.biz.address, c.biz.phones, c.biz.email, c.biz.tin.trim() ? `TIN ${c.biz.tin}` : '']) if (s.trim()) centre(s, base * 0.9);
  rule();
  centre(TITLES[c.doc.kind].book, 10 * k, c.f.bold);
  y += 2;
  pair('No.', c.doc.number, { bold: true });
  pair('Date', longDate(c.doc.date));
  if (c.doc.until && c.doc.kind !== 'receipt') pair(c.doc.kind === 'invoice' ? 'Due' : 'Valid until', longDate(c.doc.until));
  if (c.doc.customer.trim()) pair(c.doc.kind === 'receipt' ? 'Received from' : c.doc.kind === 'invoice' ? 'Bill to' : 'For', c.doc.customer);
  if (c.doc.reference.trim()) pair(c.doc.kind === 'invoice' ? 'Terms' : 'Ref.', c.doc.reference);
  rule();
  for (const l of c.doc.lines.filter((x) => x.item.trim() || x.qty || x.rate)) {
    for (const s of cv.wrap(l.item || 'Item', printable, base, c.f.bold)) {
      cv.text(s, m, y, { size: base, font: c.f.bold, color: BLACK });
      y += base * 1.25;
    }
    cv.text(`${l.qty} x ${money(l.rate)}`, m + 6 * k, y, { size: base, color: BLACK });
    cv.text(money(lineAmount(l)), x1, y, { size: base, color: BLACK, align: 'right' });
    y += base * 1.5;
  }
  rule();
  const { rows, grand, after } = totalRows(c);
  const amount = (n: number) => `${n < 0 ? '– ' : ''}${MONEY(c, Math.abs(n))}`;
  rows.forEach(([l, n]) => pair(l, amount(n)));
  y += 1;
  pair(grand[0].toUpperCase(), MONEY(c, grand[1]), { size: 10.5 * k, bold: true });
  after.forEach(([l, n]) => pair(l, amount(n)));
  y += 2;
  centre(amountInWords(c.doc.kind === 'invoice' ? c.sum.total : grand[1], c.doc.currency), base * 0.85, c.f.italic, 1.25);
  if (c.doc.kind !== 'proforma' && c.sum.paid > 0) {
    y += 2;
    pair('Paid by', c.doc.method);
    if (c.doc.payRef.trim()) pair('Ref.', c.doc.payRef);
  }
  if (c.doc.notes.trim() && c.doc.kind !== 'receipt') {
    rule();
    cv.text(c.doc.kind === 'invoice' ? 'HOW TO PAY' : 'TERMS', m, y, { size: base * 0.85, font: c.f.bold, color: BLACK });
    y += base * 1.3;
    for (const s of cv.wrap(c.doc.notes, printable, base * 0.9)) {
      cv.text(s, m, y, { size: base * 0.9, color: BLACK });
      y += base * 1.2;
    }
  }
  if (c.doc.signedBy.trim()) {
    y += 2;
    pair(c.doc.kind === 'receipt' ? 'Served by' : 'Prepared by', c.doc.signedBy);
  }
  rule();
  if (c.doc.check) {
    const size = Math.min(printable * 0.5, 96);
    drawQr(cv, c.doc.check.url, mid - size / 2, y, size);
    y += size + 2;
    centre(`Scan to check this ${c.doc.kind === 'receipt' ? 'receipt' : 'document'}`, base * 0.85, c.f.bold);
    centre(spacedCode(c.doc.check.code), base * 0.8);
    y += 3;
  }
  if (c.doc.footer.trim()) centre(c.doc.footer, base * 0.9);
  if (c.copy) {
    y += 2;
    centre(c.copy, base * 0.8, c.f.bold);
  }
  // Trim the page to the content, with a little paper below it for the tear-off.
  const used = Math.ceil(y + 18);
  cv.page.setMediaBox(0, tall - used, W, used);
}

// ============================================ document ==================================================
async function drawCopy(c: Ctx) {
  if (isSlip(c.doc.size)) return drawSlip(c);
  const [W, H] = SIZES[c.doc.size as keyof typeof SIZES];
  const lines = c.doc.lines.filter((l) => l.item.trim() || l.qty || l.rate);
  let cv = new Canvas(c.pdf.addPage([W, H]), c.f);
  const k = W / 595.28;
  /** Height of the totals, words, notes and footer that must follow the last item on its page. */
  const reserve = (x0: number) =>
    (c.doc.style === 'modern' ? modernTail(c, new Canvas(cv.page, c.f, true), 0) : bookTail(c, new Canvas(cv.page, c.f, true), x0, 0)) +
    footerHeight(c, cv, x0) +
    6 * k;
  if (c.doc.style === 'modern') {
    const m = 34 * k;
    const tail = reserve(m);
    let y = modernPage(c, cv, true);
    const cols = [m, W - m - 175 * k, W - m - 95 * k, W - m - 8 * k];
    y = modernTableHead(c, cv, y, cols);
    lines.forEach((l, i) => {
      const itemLines = cv.wrap(l.item, cols[1]! - m - 50 * k, 9 * k).slice(0, 3);
      const h = Math.max(20 * k, itemLines.length * 11 * k + 9 * k);
      if (y + h > H - 40 * k || (i === lines.length - 1 && y + h > H - tail)) {
        cv = new Canvas(c.pdf.addPage([W, H]), c.f);
        y = modernTableHead(c, cv, modernPage(c, cv, false), cols);
      }
      if (i % 2) cv.rect(m, y, W - 2 * m, h, { fill: rgb(0.98, 0.984, 0.992) });
      itemLines.forEach((s, j) => cv.text(s, m + 8 * k, y + 6 * k + j * 11 * k, { size: 9 * k }));
      cv.text(String(l.qty), cols[1]!, y + 6 * k, { size: 9 * k, align: 'right' });
      cv.text(money(l.rate), cols[2]!, y + 6 * k, { size: 9 * k, align: 'right' });
      cv.text(money(lineAmount(l)), cols[3]!, y + 6 * k, { size: 9 * k, align: 'right' });
      y += h;
      cv.line(m, y, W - m, y, { color: LINE, width: 0.7 * k });
    });
    // With no items, or a tail too tall for what is left of the page, the totals start a page of their own.
    if (y + tail > H) {
      cv = new Canvas(c.pdf.addPage([W, H]), c.f);
      y = modernPage(c, cv, false);
    }
    footer(c, cv, m, modernTail(c, cv, y));
    return;
  }
  let { x0, y } = bookPage(c, cv, true);
  let tail = reserve(x0);
  y = bookTableHead(c, cv, x0, bookFields(c, cv, x0, y));
  // A blank book rules every line that fits above the totals.
  const minRows = c.blank ? 60 : c.doc.size === 'A5' ? 6 : 12;
  for (let i = 0; i < Math.max(lines.length, minRows); i++) {
    if (y + 26 * k > H - 40 * k || (i === lines.length - 1 && y + 26 * k > H - tail)) {
      cv = new Canvas(c.pdf.addPage([W, H]), c.f);
      ({ x0, y } = bookPage(c, cv, false));
      tail = reserve(x0);
      y = bookTableHead(c, cv, x0, y);
    }
    // Spare ruled lines only while they fit above the totals.
    if (i >= lines.length && y + 19 * k > H - tail) break;
    y = bookRow(c, cv, x0, y, lines[i]);
  }
  if (y + tail > H) {
    cv = new Canvas(c.pdf.addPage([W, H]), c.f);
    ({ x0, y } = bookPage(c, cv, false));
  }
  footer(c, cv, x0, bookTail(c, cv, x0, y));
}

/** The finished PDF: the customer copy, then an office copy when asked for. */
export async function buildBizDoc(biz: Business, doc: BizDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${TITLES[doc.kind].modern} ${doc.number}`);
  pdf.setAuthor(t(biz.name) || 'Rokela PDF');
  pdf.setCreator('Rokela PDF receipts');
  // Fixed dates make the file the same every time the same document is made, so its fingerprint (receipt checks)
  // still matches when it is downloaded again.
  const when = new Date(`${/^\d{4}-\d{2}-\d{2}$/.test(doc.date) ? doc.date : '2000-01-01'}T12:00:00Z`);
  pdf.setCreationDate(when);
  pdf.setModificationDate(when);
  const f: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    mono: await pdf.embedFont(StandardFonts.CourierBold),
  };
  const base = {
    pdf,
    f,
    biz,
    doc,
    sum: totals(doc),
    main: hex(biz.color),
    accent: hex(biz.accent),
    logo: await embedImage(pdf, biz.logo),
    signature: await embedImage(pdf, doc.signature),
    stamp: await embedImage(pdf, doc.stamp),
    paidStamp: await embedImage(pdf, doc.paidStamp),
  };
  await drawCopy({ ...base, copy: doc.officeCopy ? 'CUSTOMER COPY' : '' });
  if (doc.officeCopy) await drawCopy({ ...base, copy: 'OFFICE COPY' });
  return pdf.save({ useObjectStreams: true });
}

export interface BlankBook {
  kind: DocKind;
  size: 'A4' | 'A5';
  currency: Currency;
  /** First number and how many to print. */
  start: number;
  count: number;
  counterfoil: boolean;
  /** Each number twice: CUSTOMER COPY, then OFFICE COPY. */
  officeCopy: boolean;
  /** Prints two A5 pages side by side on landscape A4, to be cut in half. */
  twoUp: boolean;
  footer: string;
  /** Invoice: how to pay. Proforma: terms. Printed on every page. */
  notes: string;
}
export const BLANK_BOOK_MAX = 200;

/**
 * A printable receipt book: numbered blank receipts, invoices or quotations in the receipt-book style, with the
 * business's letterhead, to be filled in by hand.
 */
export async function buildBlankBook(biz: Business, o: BlankBook): Promise<Uint8Array> {
  const count = Math.min(BLANK_BOOK_MAX, Math.max(1, Math.floor(o.count)));
  const start = Math.max(1, Math.floor(o.start));
  // Two to a sheet applies to A5 pages only; an A4 book is always one page per sheet.
  const twoUp = o.twoUp && o.size === 'A5';
  const size = o.size;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${TITLES[o.kind].modern} book ${docNumber(o.kind, start)}–${docNumber(o.kind, start + count - 1)}`);
  pdf.setAuthor(t(biz.name) || 'Rokela PDF');
  pdf.setCreator('Rokela PDF receipts');
  const fixed = new Date('2000-01-01T12:00:00Z');
  pdf.setCreationDate(fixed);
  pdf.setModificationDate(fixed);
  const f: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    mono: await pdf.embedFont(StandardFonts.CourierBold),
  };
  const logo = await embedImage(pdf, biz.logo);
  for (let n = start; n < start + count; n++) {
    const doc: BizDoc = {
      kind: o.kind,
      style: 'book',
      size,
      currency: o.currency,
      number: docNumber(o.kind, n),
      date: '',
      until: '',
      customer: '',
      customerDetails: '',
      reference: '',
      lines: [],
      discount: 0,
      delivery: 0,
      gst: false,
      paid: 0,
      method: '' as BizDoc['method'],
      payRef: '',
      notes: o.kind === 'receipt' ? '' : o.notes,
      footer: o.footer,
      counterfoil: o.counterfoil,
      officeCopy: o.officeCopy,
      signedBy: '',
    };
    const base = { pdf, f, biz, doc, sum: totals(doc), main: hex(biz.color), accent: hex(biz.accent), logo, blank: true };
    await drawCopy({ ...base, copy: o.officeCopy ? 'CUSTOMER COPY' : '' });
    if (o.officeCopy) await drawCopy({ ...base, copy: 'OFFICE COPY' });
  }
  if (!twoUp) return pdf.save({ useObjectStreams: true });

  // Two A5 pages on each landscape A4 sheet, with a dashed line to cut along.
  const sheet = await PDFDocument.create();
  sheet.setTitle(pdf.getTitle() ?? 'Receipt book');
  sheet.setAuthor(t(biz.name) || 'Rokela PDF');
  sheet.setCreator('Rokela PDF receipts');
  sheet.setCreationDate(fixed);
  sheet.setModificationDate(fixed);
  const pages = await sheet.embedPdf(await pdf.save(), pdf.getPageIndices());
  const [W, H] = SIZES.A4;
  for (let i = 0; i < pages.length; i += 2) {
    const page = sheet.addPage([H, W]);
    page.drawPage(pages[i]!, { x: 0, y: 0, width: H / 2, height: W });
    if (pages[i + 1]) page.drawPage(pages[i + 1]!, { x: H / 2, y: 0, width: H / 2, height: W });
    page.drawLine({ start: { x: H / 2, y: 0 }, end: { x: H / 2, y: W }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6), dashArray: [4, 4] });
  }
  return sheet.save({ useObjectStreams: true });
}
