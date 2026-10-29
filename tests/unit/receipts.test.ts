import { describe, expect, it } from 'vitest';
import jsQRModule from 'jsqr';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { amountInWords, DEFAULT_BUSINESS, DEFAULT_FOOTERS, docNumber, lineAmount, numberWords, totals, type BizDoc } from '@/lib/receipts/model';
import { BLANK_BOOK_MAX, buildBizDoc, buildBlankBook, type BlankBook } from '@/lib/receipts/pdf';
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

  it('makes 80 mm and 58 mm till slips as long as their content, with the facts and the check code', async () => {
    for (const [size, mm] of [
      ['80mm', 80],
      ['58mm', 58],
    ] as const) {
      const short = await buildBizDoc(biz, doc({ size, check: { url: 'https://rokelapdf.com/receipts/ABCDEFGHJKMNPQRS', code: 'ABCDEFGHJKMNPQRS' } }));
      const page = (await PDFDocument.load(short)).getPage(0);
      expect(page.getWidth()).toBeCloseTo((mm * 72) / 25.4, 1);
      const lines = Array.from({ length: 30 }, (_, i) => ({ qty: 1, item: `Item ${i + 1}`, rate: 10 }));
      const long = (await PDFDocument.load(await buildBizDoc(biz, doc({ size, lines })))).getPage(0);
      expect(long.getHeight()).toBeGreaterThan(page.getHeight());
      const [text] = await textOf(short);
      expect(text).toContain('KAMARA & SONS HARDWARE');
      expect(text).toContain('CASH SALES RECEIPT');
      expect(text).toContain('NLe 3,450.00');
      expect(text).toContain('ABCD EFGH JKMN PQRS');
    }
  });

  it('never draws past the bottom of a page, whatever the number of items, charges and notes', async () => {
    const notes = 'Pay to Rokel Commercial Bank, account 0012345678, or Orange Money 076 123 456. Quote the invoice number.';
    for (const style of ['book', 'modern'] as const)
      for (const size of ['A4', 'A5'] as const)
        for (const n of [1, 8, 14, 20, 26, 33]) {
          const lines = Array.from({ length: n }, (_, i) => ({ qty: 1, item: `Item ${i + 1}`, rate: 10 }));
          const bytes = await buildBizDoc(
            biz,
            doc({
              kind: 'invoice',
              style,
              size,
              lines,
              discount: 5,
              delivery: 20,
              gst: true,
              notes,
              officeCopy: true,
              signedBy: 'A. Kamara',
              customer: 'Sunrise Ltd',
            }),
          );
          const pdf = await getDocument({ data: bytes.slice(), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise;
          const all: string[] = [];
          for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const items = (await page.getTextContent()).items as Array<{ str: string; transform: number[] }>;
            for (const it of items) expect(it.transform[5], `${style} ${size} ${n} items, page ${p}: "${it.str}"`).toBeGreaterThan(0);
            all.push(items.map((x) => x.str).join(' '));
          }
          const text = all.join(' ');
          expect(text, `${style} ${size} ${n}`).toContain(`Item ${n}`);
          expect(text).toContain('A. Kamara');
          expect(text).toContain('Rokel Commercial Bank');
        }
  });
});

describe('line amounts', () => {
  it('round each line to the cent, so the printed lines add up to the sub-total', () => {
    const lines = [
      { qty: 1.25, item: 'a', rate: 0.1 },
      { qty: 1.25, item: 'b', rate: 0.1 },
    ];
    expect(lineAmount(lines[0]!)).toBe(0.13);
    expect(totals({ kind: 'receipt', lines, discount: 0, delivery: 0, gst: false, paid: 0 }).subtotal).toBe(0.26);
  });
});

describe('blank receipt books', () => {
  const book = (over: Partial<BlankBook> = {}): BlankBook => ({
    kind: 'receipt',
    size: 'A5',
    currency: 'NLe',
    start: 101,
    count: 3,
    counterfoil: true,
    officeCopy: false,
    twoUp: false,
    footer: 'Thank you',
    notes: '',
    ...over,
  });

  it('prints numbered basic cash receipts four per landscape A4 sheet', async () => {
    const bytes = await buildBlankBook(biz, book({ basic: true, count: 5, officeCopy: false }));
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
    expect([Math.round(pdf.getPage(0).getWidth()), Math.round(pdf.getPage(0).getHeight())]).toEqual([842, 595]);
    const pages = await textOf(bytes);
    for (const number of ['0101', '0102', '0103', '0104']) expect(pages[0]).toContain(number);
    expect(pages[1]).toContain('0105');
    expect(pages[0]).toContain('Received from:');
    expect(pages[0]).toContain('Being part/full payment for:');
    expect(pages[0]).toContain('Paid by / reference:');
  });

  it('keeps customer and office copies together and preserves the original default', async () => {
    const pages = await textOf(await buildBlankBook(biz, book({ basic: true, count: 3, officeCopy: true })));
    expect(pages).toHaveLength(2);
    expect(pages[0]!.replace(/\s/g, '')).toContain('CUSTOMERCOPY');
    expect(pages[0]!.replace(/\s/g, '')).toContain('OFFICECOPY');
    expect(Buffer.from(await buildBlankBook(biz, book())).equals(Buffer.from(await buildBlankBook(biz, book({ basic: false }))))).toBe(true);
  });

  it('keeps long business details and footer on the compact receipt', async () => {
    const name = `BUSINESS${'X'.repeat(100)}`;
    const email = `contact${'x'.repeat(100)}@example.com`;
    const footer = `THANKYOU${'X'.repeat(100)}`;
    const pages = await textOf(await buildBlankBook({ ...biz, name, email }, book({ basic: true, count: 1, footer })));
    expect(pages[0]).toContain(name);
    expect(pages[0]).toContain(email);
    expect(pages[0]).toContain(footer);
  });

  it('cuts a footer too long for one line on the compact receipt instead of overprinting it', async () => {
    const footer = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const pages = await textOf(await buildBlankBook(biz, book({ basic: true, count: 1, footer })));
    expect(pages[0]).toContain('word0 ');
    expect(pages[0]).toContain('…');
    expect(pages[0]).not.toContain('word399');
  });

  it('numbers each page in order, with the letterhead and nothing filled in', async () => {
    const pages = await textOf(await buildBlankBook(biz, book()));
    expect(pages).toHaveLength(3);
    pages.forEach((p, i) => {
      expect(p).toContain(`010${i + 1}`);
      expect(p).toMatch(/KAMARA & SONS HARDWARE/);
      expect(p).toContain('Received from');
      expect(p).not.toMatch(/0\.00|Zero|Only/);
    });
  });

  it('prints office copies after each number, two A5 pages per landscape A4 sheet, and invoice numbering', async () => {
    const bytes = await buildBlankBook(biz, book({ kind: 'invoice', officeCopy: true, twoUp: true, notes: 'Pay to Rokel Commercial Bank' }));
    const d = await PDFDocument.load(bytes);
    expect(d.getPageCount()).toBe(3); // 3 numbers × 2 copies, two per sheet
    expect([Math.round(d.getPage(0).getWidth()), Math.round(d.getPage(0).getHeight())]).toEqual([842, 595]);
    const [first] = await textOf(bytes);
    expect(first).toContain('INV-0101');
    expect(first!.replace(/\s/g, '')).toContain('CUSTOMERCOPY');
    expect(first!.replace(/\s/g, '')).toContain('OFFICECOPY');
    expect(first).toContain('Pay to Rokel Commercial Bank');
  });

  it('prints an A4 book one page per A4 sheet even if two-to-a-sheet was ticked for A5', async () => {
    const d = await PDFDocument.load(await buildBlankBook(biz, book({ size: 'A4', twoUp: true })));
    expect(d.getPageCount()).toBe(3);
    expect([Math.round(d.getPage(0).getWidth()), Math.round(d.getPage(0).getHeight())]).toEqual([595, 842]);
  });

  it(`stops at ${BLANK_BOOK_MAX} numbers`, async () => {
    const d = await PDFDocument.load(await buildBlankBook(biz, book({ size: 'A4', count: 10_000, start: 1 })));
    expect(d.getPageCount()).toBe(BLANK_BOOK_MAX);
  });
});
