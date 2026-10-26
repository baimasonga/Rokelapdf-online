import { describe, expect, it } from 'vitest';
import jsQRModule from 'jsqr';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { amountInWords, DEFAULT_BUSINESS, DEFAULT_FOOTERS, docNumber, numberWords, totals, type BizDoc } from '@/lib/receipts/model';
import { buildBizDoc } from '@/lib/receipts/pdf';
import { loadPrefs } from '@/lib/receipts/store';

describe('amount in words', () => {
  it('writes amounts the way receipt books do, in New Leones', () => {
    expect(amountInWords(5400)).toBe('Five Thousand Four Hundred New Leones Only');
    expect(amountInWords(20970)).toBe('Twenty Thousand Nine Hundred and Seventy New Leones Only');
    expect(amountInWords(2500.5)).toBe('Two Thousand Five Hundred New Leones and Fifty Cents Only');
    expect(amountInWords(1)).toBe('One New Leone Only');
    expect(amountInWords(1005)).toBe('One Thousand and Five New Leones Only');
    expect(amountInWords(1_250_000.01)).toBe('One Million Two Hundred and Fifty Thousand New Leones and One Cent Only');
    expect(amountInWords(120, 'USD')).toBe('One Hundred and Twenty US Dollars Only');
    expect(numberWords(0)).toBe('Zero');
    expect(numberWords(99)).toBe('Ninety-Nine');
  });
});

const doc = (over: Partial<BizDoc> = {}): BizDoc => ({
  kind: 'receipt',
  style: 'modern',
  size: 'A4',
  currency: 'NLe',
  number: '0457',
  date: '2026-10-26',
  until: '',
  customer: 'Mr. Ibrahim Conteh',
  customerDetails: '',
  reference: '',
  lines: [
    { qty: 10, item: 'Cement, 50 kg bag', rate: 155 },
    { qty: 20, item: 'Iron rod, 12 mm', rate: 95 },
  ],
  discount: 0,
  delivery: 0,
  gst: false,
  paid: 0,
  method: 'Orange Money',
  payRef: 'PP261026.1432.A71234',
  notes: '',
  footer: DEFAULT_FOOTERS.receipt,
  counterfoil: true,
  officeCopy: false,
  signedBy: 'A. Kamara',
  ...over,
});

describe('totals and numbers', () => {
  it('adds discount, delivery and GST in that order, and a receipt is always paid in full', () => {
    const r = totals(doc({ discount: 450, delivery: 250, gst: true }));
    expect(r).toMatchObject({ subtotal: 3450, discount: 450, delivery: 250, gst: 487.5, total: 3737.5, paid: 3737.5, balance: 0 });
  });
  it('an invoice carries the balance; a quotation is never paid', () => {
    expect(totals(doc({ kind: 'invoice', paid: 1000 }))).toMatchObject({ total: 3450, paid: 1000, balance: 2450 });
    expect(totals(doc({ kind: 'invoice', paid: 99999 })).balance).toBe(0);
    expect(totals(doc({ kind: 'proforma', paid: 500 })).paid).toBe(0);
    expect(totals(doc({ discount: 1e9 })).total).toBe(0);
  });
  it('numbers documents per kind', () => {
    expect([docNumber('receipt', 457), docNumber('invoice', 213), docNumber('proforma', 89)]).toEqual(['0457', 'INV-0213', 'PF-0089']);
  });
});

describe('saved settings', () => {
  it('repairs damaged settings instead of failing', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };
    store.set(
      'rokela.receipts.v1',
      JSON.stringify({
        business: { name: 5, color: 'red', logo: 'javascript:alert(1)' },
        counters: { receipt: -4, invoice: 'x' },
        items: { Cement: 155, Bad: -1 },
        style: 'weird',
      }),
    );
    const p = loadPrefs();
    expect(p.business).toMatchObject({ name: '', color: DEFAULT_BUSINESS.color });
    expect(p.business.logo).toBeUndefined();
    expect(p.counters).toEqual({ receipt: 0, invoice: 0, proforma: 0 });
    expect(p.items).toEqual({ Cement: 155 });
    expect(p.style).toBe('modern');
    store.set('rokela.receipts.v1', '{not json');
    expect(loadPrefs().counters.receipt).toBe(0);
  });
});

async function textOf(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({ data: bytes.slice(), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++)
    pages.push(((await (await pdf.getPage(i)).getTextContent()).items as Array<{ str: string }>).map((x) => x.str).join(' '));
  return pages;
}
const biz = { ...DEFAULT_BUSINESS, name: 'Kamara & Sons Hardware', address: '14 Kissy Road, Freetown', phones: '+232 76 123 456' };

describe('the PDF', () => {
  it('is A4 or A5, in either style, with the business, the number, the total and the amount in words', async () => {
    for (const style of ['book', 'modern'] as const)
      for (const size of ['A4', 'A5'] as const) {
        const bytes = await buildBizDoc(biz, doc({ style, size }));
        const d = await PDFDocument.load(bytes);
        expect(Math.round(d.getPage(0).getWidth())).toBe(size === 'A4' ? 595 : 420);
        const [text] = await textOf(bytes);
        expect(text).toContain('0457');
        expect(text).toMatch(/Kamara & Sons Hardware/i);
        expect(text).toContain('3,450.00');
        expect(text).toContain('Three Thousand Four Hundred and Fifty New Leones Only');
        expect(text).toContain('Goods sold are not returnable');
      }
  });

  it('adds an office copy, and an invoice shows its balance due', async () => {
    const bytes = await buildBizDoc(biz, doc({ kind: 'invoice', number: 'INV-0213', paid: 1000, officeCopy: true, customer: 'Sunrise Construction Ltd' }));
    const pages = await textOf(bytes);
    expect(pages).toHaveLength(2);
    // The copy label is letter-spaced, so its letters come back separated.
    expect(pages[0]!.replace(/\s/g, '')).toContain('CUSTOMERCOPY');
    expect(pages[1]!.replace(/\s/g, '')).toContain('OFFICECOPY');
    expect(pages[0]).toMatch(/Balance due/i);
    expect(pages[0]).toContain('2,450.00');
  });

  it('continues a long quotation on a second page', async () => {
    const lines = Array.from({ length: 45 }, (_, i) => ({ qty: 1, item: `Item ${i + 1}`, rate: 10 }));
    for (const style of ['book', 'modern'] as const) {
      const pages = await textOf(await buildBizDoc(biz, doc({ kind: 'proforma', style, lines, customer: 'Hope for Children SL' })));
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.join(' ')).toContain('Item 45');
      expect(pages.at(-1)).toContain('450.00');
    }
  });

  it('keeps characters the built-in font cannot draw from breaking the file', async () => {
    const bytes = await buildBizDoc({ ...biz, name: 'Ṣọ́pù 店 Shop' }, doc({ customer: 'Ama 🙂' }));
    expect((await textOf(bytes))[0]).toContain('Shop');
  });

  it('prints a scannable check QR code with its code, in either style and size, and is the same file every time', async () => {
    const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as unknown as (
      d: Uint8ClampedArray,
      w: number,
      h: number,
    ) => { data: string } | null;
    const check = { url: 'https://rokelapdf.com/receipts/ABCDEFGHJKMNPQRS', code: 'ABCDEFGHJKMNPQRS' };
    for (const style of ['book', 'modern'] as const)
      for (const size of ['A4', 'A5'] as const) {
        const bytes = await buildBizDoc(biz, doc({ style, size, check }));
        expect(Buffer.from(await buildBizDoc(biz, doc({ style, size, check }))).equals(Buffer.from(bytes))).toBe(true);
        const [text] = await textOf(bytes);
        expect(text).toContain('Scan to check');
        expect(text).toContain('ABCD EFGH JKMN PQRS');
        const pdf = await getDocument({ data: bytes.slice(), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement }).promise;
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        expect(jsQR(new Uint8ClampedArray(img.data), img.width, img.height)?.data, `${style} ${size}`).toBe(check.url);
      }
  });
});
