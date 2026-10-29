import { describe, expect, it } from 'vitest';
import { cleanSaved, cleanSynced, copyAsNew, docKey, memoryDocs, toSaved } from '@/lib/receipts/docs';
import { DEFAULT_PREFS, newDoc } from '@/lib/receipts/store';
import type { BizDoc } from '@/lib/receipts/model';

const invoice = (): BizDoc => ({
  ...newDoc('invoice', DEFAULT_PREFS),
  number: 'INV-0007',
  date: '2026-10-20',
  until: '2026-11-19',
  customer: 'Sunrise Construction Ltd',
  customerDetails: 'Wilkinson Road',
  reference: 'Credit, 30 days',
  lines: [
    { qty: 10, item: 'Cement, 50 kg bag', rate: 155 },
    { qty: 2, item: 'Roofing sheet', rate: 300 },
  ],
  delivery: 50,
  gst: true,
  paid: 200,
  method: 'Orange Money',
  payRef: '076 123 456',
  notes: 'Pay to Rokel Bank 0012',
  signedBy: 'A. Kamara',
  signature: 'data:image/png;base64,SIG',
  stamp: 'data:image/png;base64,STAMP',
  paidStamp: 'data:image/png;base64,PAID',
  check: { url: 'https://www.rokelapdf.com/receipts/ABCD', code: 'ABCD' },
});

describe('saved documents', () => {
  it('keeps everything written on a document but its pictures, and the stamp it carried', () => {
    const s = toSaved(invoice(), 'stamp1', 1234);
    expect(s).not.toHaveProperty('signature');
    expect(s).not.toHaveProperty('stamp');
    expect(s).not.toHaveProperty('paidStamp');
    expect(s.stampId).toBe('stamp1');
    expect(s.savedAt).toBe(1234);
    expect(s.lines).toHaveLength(2);
    expect(cleanSaved(s)).toEqual(s);
  });

  it('reads a document in the API’s snake_case and repairs damage', () => {
    const s = toSaved(invoice(), undefined, 99);
    const wire = { ...s, customer_details: s.customerDetails, pay_ref: s.payRef, signed_by: s.signedBy, saved_at: 99 } as Record<string, unknown>;
    for (const k of ['customerDetails', 'payRef', 'signedBy', 'savedAt']) delete wire[k];
    expect(cleanSaved(wire)).toEqual(s);
    expect(cleanSaved({ kind: 'letter', number: '1', date: '2026-01-01' })).toBeUndefined();
    expect(cleanSaved({ kind: 'receipt', number: '', date: '2026-01-01' })).toBeUndefined();
    const odd = cleanSaved({
      kind: 'receipt',
      number: '0009',
      date: '2026-01-01',
      lines: [{ qty: -1, item: 5, rate: 'x' }],
      method: 'Gold',
      check: { url: 'javascript:x', code: 'A' },
    })!;
    expect(odd.lines).toEqual([{ qty: 0, item: '', rate: 0 }]);
    expect(odd.method).toBe('Cash');
    expect(odd.check).toBeUndefined();
  });

  it('copies a document into a new one with the next number and today, unpaid', () => {
    const prefs = { ...DEFAULT_PREFS, counters: { receipt: 0, invoice: 12, proforma: 0 } };
    const d = copyAsNew(toSaved(invoice(), undefined), prefs);
    expect(d.number).toBe('INV-0013');
    expect(d.date).not.toBe('2026-10-20');
    expect(d.customer).toBe('Sunrise Construction Ltd');
    expect(d.lines.map((l) => l.item)).toEqual(['Cement, 50 kg bag', 'Roofing sheet']);
    expect(d.gst).toBe(true);
    expect(d.paid).toBe(0);
    expect(d.check).toBeUndefined();
    expect(d.against).toBeUndefined();
  });

  it('keeps a document with its ledger entry only when they are the same document', () => {
    const entry = { kind: 'invoice', number: 'INV-0007', date: '2026-10-20', customer: 'Sunrise', currency: 'NLe', total: 2000 };
    const doc = toSaved(invoice(), undefined, 5);
    expect(cleanSynced({ ...entry, doc })?.doc).toEqual(doc);
    expect(cleanSynced({ ...entry, number: 'INV-0008', doc })?.doc).toBeUndefined();
    expect(cleanSynced({ ...entry, doc: { junk: true } })).not.toHaveProperty('doc');
  });

  it('stores documents per business', async () => {
    const store = memoryDocs();
    const doc = toSaved(invoice(), undefined);
    await store.put('main', doc);
    expect(await store.get('main', docKey(doc))).toEqual(doc);
    expect(await store.get('bother', docKey(doc))).toBeUndefined();
    expect([...(await store.keys('main'))]).toEqual(['invoice inv-0007']);
  });
});
