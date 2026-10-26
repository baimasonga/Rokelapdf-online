// Stamp designs for the Stamp Studio: what a stamp says and looks like. Plain data, saved on the device; the picture
// itself is drawn by render.ts and given its ink by ink.ts.

export type StampShape = 'round' | 'rect' | 'oval';

export interface StampDesign {
  id: string;
  /** What the person calls it in their list. */
  name: string;
  shape: StampShape;
  /** Ink colour, #rrggbb. */
  ink: string;
  /** Round and oval: the text around the top edge. Rectangle: the large first line. */
  top: string;
  /** Round and oval: the words in the middle. Rectangle: the second line. */
  middle: string;
  /** Round and oval: the text around the bottom edge. Rectangle: the small last line. */
  bottom: string;
  /** Adds today's date, like a date stamp. */
  date: boolean;
  /** Adds a number that goes up by one every time the stamp is used. */
  numbered: boolean;
  /** The next number to print. */
  next: number;
  /** Width on paper, in millimetres. */
  sizeMm: number;
  /** 0 = clean, 1 = heavily hand-stamped. */
  wear: number;
}

export const INKS: Array<{ name: string; hex: string }> = [
  { name: 'Blue', hex: '#2336a8' },
  { name: 'Red', hex: '#c42a2a' },
  { name: 'Violet', hex: '#5a2a8c' },
  { name: 'Green', hex: '#1d7a3e' },
  { name: 'Black', hex: '#1f2024' },
];

type Template = Omit<StampDesign, 'id'>;
export const TEMPLATES: Array<{ key: string; label: string; design: Template }> = [
  {
    key: 'seal',
    label: 'Company seal',
    design: {
      name: 'Company seal',
      shape: 'round',
      ink: '#2336a8',
      top: 'YOUR COMPANY NAME LTD',
      middle: 'OFFICIAL\nSTAMP',
      bottom: 'FREETOWN · SIERRA LEONE',
      date: false,
      numbered: false,
      next: 1,
      sizeMm: 40,
      wear: 0.55,
    },
  },
  {
    key: 'received',
    label: 'Received',
    design: {
      name: 'Received',
      shape: 'rect',
      ink: '#c42a2a',
      top: 'RECEIVED',
      middle: '',
      bottom: 'YOUR COMPANY NAME',
      date: true,
      numbered: false,
      next: 1,
      sizeMm: 55,
      wear: 0.55,
    },
  },
  {
    key: 'paid',
    label: 'Paid',
    design: {
      name: 'Paid',
      shape: 'rect',
      ink: '#1d7a3e',
      top: 'PAID',
      middle: '',
      bottom: 'ACCOUNTS',
      date: true,
      numbered: true,
      next: 1,
      sizeMm: 50,
      wear: 0.55,
    },
  },
  {
    key: 'approved',
    label: 'Approved',
    design: {
      name: 'Approved',
      shape: 'oval',
      ink: '#2336a8',
      top: 'APPROVED',
      middle: '',
      bottom: 'FINANCE DEPARTMENT',
      date: true,
      numbered: false,
      next: 1,
      sizeMm: 50,
      wear: 0.55,
    },
  },
  {
    key: 'certified',
    label: 'Certified true copy',
    design: {
      name: 'Certified true copy',
      shape: 'rect',
      ink: '#5a2a8c',
      top: 'CERTIFIED TRUE COPY',
      middle: 'Sign: ____________________',
      bottom: 'YOUR COMPANY NAME',
      date: true,
      numbered: false,
      next: 1,
      sizeMm: 60,
      wear: 0.5,
    },
  },
];

let seq = 0;
export function newStamp(t: Template): StampDesign {
  return { ...t, id: `s${Date.now().toString(36)}${(seq++).toString(36)}` };
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** "26 OCT 2026", as date stamps print it. */
export function stampDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
/** "No. 000124". */
export function stampNumber(n: number): string {
  return `No. ${String(Math.max(0, Math.floor(n))).padStart(6, '0')}`;
}

/** Points per millimetre (PDF units). */
export const PT_PER_MM = 72 / 25.4;

/** Keeps a saved design usable: right types, sensible ranges, text length limits. */
export function cleanDesign(x: unknown): StampDesign | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const shape = o.shape === 'round' || o.shape === 'rect' || o.shape === 'oval' ? o.shape : undefined;
  if (!shape || typeof o.id !== 'string') return undefined;
  const ink = typeof o.ink === 'string' && /^#[0-9a-f]{6}$/i.test(o.ink) ? o.ink : INKS[0]!.hex;
  const numOr = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    id: o.id.slice(0, 40),
    name: str(o.name, 60) || 'Stamp',
    shape,
    ink,
    top: str(o.top, 60),
    middle: str(o.middle, 80),
    bottom: str(o.bottom, 60),
    date: o.date === true,
    numbered: o.numbered === true,
    next: Math.floor(numOr(o.next, 1, 0, 999999)),
    sizeMm: numOr(o.sizeMm, 45, 20, 120),
    wear: numOr(o.wear, 0.55, 0, 1),
  };
}
