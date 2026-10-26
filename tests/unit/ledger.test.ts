import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  customers,
  entryFromDoc,
  invoiceState,
  ledgerCsv,
  loadLedger,
  openInvoices,
  setVoid,
  statement,
  summary,
  upsert,
  type LedgerEntry,
} from '@/lib/receipts/ledger';
import { DEFAULT_BUSINESS, type BizDoc } from '@/lib/receipts/model';
import { buildStatement } from '@/lib/receipts/pdf';

const e = (over: Partial<LedgerEntry>): LedgerEntry => ({
  kind: 'invoice',
  number: 'INV-0001',
  date: '2026-08-01',
  due: '2026-08-31',
  customer: 'Sunrise Construction Ltd',
  currency: 'NLe',
  total: 1000,
  paidAtIssue: 0,
  ...over,
});

/** Newest first, as the Receipt Maker adds them. */
const book = (...entries: LedgerEntry[]) => entries.reduce<LedgerEntry[]>((acc, x) => upsert(acc, x), []);

const ledger = book(
  e({ number: 'INV-0001', date: '2026-07-10', due: '2026-08-09', total: 1000 }),
  e({ number: 'INV-0002', date: '2026-08-05', due: '2026-09-04', total: 2500, paidAtIssue: 500 }),
  e({ kind: 'receipt', number: '0101', date: '2026-08-20', due: '', total: 600, against: 'INV-0001', method: 'Orange Money' }),
  e({ kind: 'receipt', number: '0102', date: '2026-09-02', due: '', total: 400, against: 'inv-0001', method: 'Cash' }),
  e({ kind: 'receipt', number: '0103', date: '2026-09-03', due: '', total: 75, customer: 'Walk-in' }),
  e({ kind: 'proforma', number: 'PF-0001', date: '2026-09-04', due: '2026-09-18', total: 9000 }),
  e({ number: 'INV-0003', date: '2026-09-10', due: '2026-10-10', total: 300, customer: '  sunrise construction  LTD ' }),
  e({ number: 'INV-0004', date: '2026-09-12', due: '2026-10-12', total: 800, customer: 'Hope for Children SL' }),
);

describe('the sales ledger', () => {
  it('makes an entry from a document, and saving the same document again replaces it', () => {
    const doc = {
      kind: 'invoice',
      number: ' INV-0007 ',
      date: '2026-10-01',
      until: '2026-10-31',
      customer: 'Ama Stores',
      currency: 'NLe',
      lines: [{ qty: 2, item: 'Cement', rate: 155 }],
      discount: 0,
      delivery: 0,
      gst: false,
      paid: 100,
      method: 'Cash',
    } as unknown as BizDoc;
    const x = entryFromDoc(doc);
    expect(x).toMatchObject({ kind: 'invoice', number: 'INV-0007', total: 310, paidAtIssue: 100, due: '2026-10-31' });
    const twice = upsert(upsert([], x), { ...x, total: 320 });
    expect(twice).toHaveLength(1);
    expect(twice[0]!.total).toBe(320);
    // Same number, different kind: a different document.
    expect(upsert(twice, { ...x, kind: 'proforma' })).toHaveLength(2);
  });

  it('works out what each invoice still owes, and which are overdue', () => {
    const inv1 = ledger.find((x) => x.number === 'INV-0001')!;
    const inv2 = ledger.find((x) => x.number === 'INV-0002')!;
    // Receipts match their invoice regardless of case.
    expect(invoiceState(ledger, inv1, '2026-10-26')).toEqual({ paid: 1000, balance: 0, status: 'paid' });
    expect(invoiceState(ledger, inv2, '2026-09-01')).toEqual({ paid: 500, balance: 2000, status: 'part' });
    expect(invoiceState(ledger, inv2, '2026-10-26').status).toBe('overdue');
    expect(openInvoices(ledger, '2026-10-26', 'SUNRISE CONSTRUCTION LTD').map((x) => x.inv.number)).toEqual(['INV-0002', 'INV-0003']);
  });

  it('sums sales, money received and what is owed, leaving out quotations and cancelled documents', () => {
    const s = summary(ledger, 'NLe', '2026-09-01', '2026-09-30', '2026-10-26');
    // Sales in September: INV-0003 300 + INV-0004 800 + cash sale 75; payments on account are not sales.
    expect(s).toEqual({ sales: 1175, received: 475, outstanding: 3100, overdue: 3100, documents: 5 });
    const voided = setVoid(ledger, { kind: 'invoice', number: 'INV-0004' }, true);
    expect(summary(voided, 'NLe', '2026-09-01', '2026-09-30', '2026-10-26')).toMatchObject({ sales: 375, outstanding: 2300 });
    expect(summary(ledger, 'USD', '2026-01-01', '2026-12-31', '2026-10-26').documents).toBe(0);
  });

  it('lists customers who owe most first, merging differently typed names', () => {
    expect(customers(ledger, 'NLe', '2026-10-26').map((c) => [c.name, c.owed, c.invoices])).toEqual([
      ['Sunrise Construction Ltd', 2300, 3],
      ['Hope for Children SL', 800, 1],
    ]);
  });

  it('makes a statement with an opening balance, a running balance and ageing', () => {
    const st = statement(ledger, 'sunrise construction ltd', 'NLe', '2026-08-01', '2026-09-30');
    expect(st.opening).toBe(1000); // INV-0001 from July
    expect(st.rows.map((r) => [r.date, r.ref, r.charge, r.payment, r.balance])).toEqual([
      ['2026-08-05', 'INV-0002', 2500, 0, 3500],
      ['2026-08-05', 'INV-0002', 0, 500, 3000],
      ['2026-08-20', '0101', 0, 600, 2400],
      ['2026-09-02', '0102', 0, 400, 2000],
      ['2026-09-10', 'INV-0003', 300, 0, 2300],
    ]);
    expect(st.closing).toBe(2300);
    // At 30 September: INV-0002 (due 4 Sept) is 26 days late; INV-0003 is not yet due.
    expect(st.ageing).toEqual([300, 2000, 0, 0, 0]);
    expect(st.rows.some((r) => r.ref === '0103' || r.ref === 'PF-0001')).toBe(false);
  });

  it('exports a spreadsheet that cannot run formulas', () => {
    const csv = ledgerCsv(book(e({ customer: '=HYPERLINK("x")', number: 'INV-9' })), '2026-10-26');
    expect(csv.split('\r\n')[0]).toBe('Date,Type,Number,Customer,Currency,Total,Paid,Balance,Status,For invoice,Method');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('1000.00,0.00,1000.00,overdue');
  });

  it('drops damaged saved entries instead of failing', () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Pick<Storage, 'getItem'> }).localStorage = { getItem: (k: string) => store.get(k) ?? null };
    store.set('rokela.ledger.v1', JSON.stringify([e({}), { kind: 'cheque' }, null, { ...e({}), date: 'yesterday' }, { ...e({}), total: -5, void: true }]));
    const out = loadLedger();
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ total: 0, void: true });
    store.set('rokela.ledger.v1', '{not json');
    expect(loadLedger()).toEqual([]);
  });
});

describe('the statement PDF', () => {
  it('shows the customer, every movement, the ageing and the amount due, over pages when long', async () => {
    const many = book(...Array.from({ length: 60 }, (_, i) => e({ number: `INV-${1000 + i}`, date: '2026-09-01', total: 10 })));
    for (const [entries, pagesMin] of [
      [ledger, 1],
      [many, 2],
    ] as const) {
      const st = statement(entries, 'Sunrise Construction Ltd', 'NLe', '2026-08-01', '2026-09-30');
      const bytes = await buildStatement({ ...DEFAULT_BUSINESS, name: 'Kamara & Sons Hardware' }, st, '2026-10-26');
      const pdf = await getDocument({ data: bytes.slice(), standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }).promise;
      expect(pdf.numPages).toBeGreaterThanOrEqual(pagesMin);
      let text = '';
      for (let p = 1; p <= pdf.numPages; p++) {
        const items = (await (await pdf.getPage(p)).getTextContent()).items as Array<{ str: string; transform: number[] }>;
        for (const it of items) expect(it.transform[5]).toBeGreaterThan(0);
        text += items.map((x) => x.str).join(' ') + ' ';
      }
      expect(text).toContain('Statement of account');
      expect(text).toContain('Sunrise Construction Ltd');
      expect(text).toContain('Opening balance');
      expect(text).toContain(`NLe ${st.closing.toLocaleString('en-GB', { minimumFractionDigits: 2 })}`);
      expect(text).toContain(`Page ${pdf.numPages} of ${pdf.numPages}`);
    }
  });
});
