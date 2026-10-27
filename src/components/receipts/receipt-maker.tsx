'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { BookOpen, ClipboardList, Download, FilePlus2, ImagePlus, Plus, QrCode, Share2, Stamp as StampIcon, Trash2 } from 'lucide-react';
import { usePaid } from '@/components/paid';
import { ApiError, api } from '@/lib/client/api';
import { PREVIEW_CODE, checkedPdf, type Issued, type Post } from '@/lib/receipts/check';
import { currentSession, sessionToken } from '@/lib/client/auth';
import { useReceiptSync } from '@/lib/receipts/use-sync';
import { applySync, mergeEntries } from '@/lib/receipts/sync';
import { Button } from '@/components/ui';
import { SignaturePad } from '@/components/editor/signature-pad';
import { StampStudio } from '@/components/editor/stamp-studio';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { closePdf, openPdf } from '@/components/editor/pdfjs';
import {
  DEFAULT_BUSINESS,
  PAY_METHODS,
  TITLES,
  docNumber,
  isSlip,
  lineAmount,
  money,
  totals,
  type BizDoc,
  type Business,
  type DocKind,
  type Line,
  type PayMethod,
} from '@/lib/receipts/model';
import { BLANK_BOOK_MAX, buildBizDoc, buildBlankBook, type BlankBook } from '@/lib/receipts/pdf';
import { DEFAULT_PREFS, afterDoc, isoDate, loadPrefs, logoDataUrl, newDoc, numberOf, savePrefs, type ReceiptPrefs } from '@/lib/receipts/store';
import { entryFromDoc, loadLedger, openInvoices, saveLedger, setVoid, upsert, type LedgerEntry } from '@/lib/receipts/ledger';
import { LedgerView } from './ledger-view';
import { TEMPLATES, newStamp } from '@/lib/stamp/design';
import { renderStamp } from '@/lib/stamp/render';
import { loadStamps } from '@/lib/stamp/store';

// The Receipt Maker: cash receipts, sales invoices and proforma invoices for small and medium businesses, in the
// "receipt book" or "modern" style, A4 or A5. Everything is made on this device; the business's profile, numbering
// and usual prices stay in this browser. Downloading is a Pro feature (src/lib/licensing.ts).

const KINDS: Array<[DocKind, string]> = [
  ['receipt', 'Cash receipt'],
  ['invoice', 'Invoice'],
  ['proforma', 'Proforma'],
];
const iso = isoDate;
/** A stable number from text, so a document keeps the same stamp impression while it is edited. */
const seedOf = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
const SIGN_IN = 'signin';

const blankDoc = newDoc;

export function ReceiptMaker() {
  const paid = usePaid();
  const [prefs, setPrefs] = useState<ReceiptPrefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  const [doc, setDoc] = useState<BizDoc>(() => blankDoc('receipt', DEFAULT_PREFS));
  const [sigOpen, setSigOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [stamps, setStamps] = useState(() => [] as ReturnType<typeof loadStamps>);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pages, setPages] = useState(0);
  /** "Your business" starts open for a new business, then stays as the person leaves it. */
  const [bizOpen, setBizOpen] = useState(false);
  /** Fill in one document, or print a blank numbered receipt book to fill in by hand. */
  const [mode, setMode] = useState<'doc' | 'book' | 'ledger'>('doc');
  /** Every document downloaded or shared here (sales ledger), newest first. */
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [book, setBook] = useState<BlankBook>({
    kind: 'receipt',
    size: 'A5',
    currency: 'NLe',
    start: 1,
    count: 50,
    counterfoil: true,
    officeCopy: false,
    twoUp: true,
    footer: DEFAULT_PREFS.footers.receipt,
    notes: '',
  });
  /** Two to a sheet applies to A5 pages only (the box is hidden for A4, and keeps its value for when A5 is chosen again). */
  const bookTwoUp = book.twoUp && book.size === 'A5';
  const setB = <K extends keyof BlankBook>(k: K, v: BlankBook[K]) => setBook((b) => ({ ...b, [k]: v }));
  /** The last receipt check registered, and the facts it vouches for, so downloading again reuses it. */
  const issued = useRef<Issued>(undefined);
  const canvas = useRef<HTMLCanvasElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  // Settings are read once in the browser (they are not available while the page is rendered on the server).
  useEffect(() => {
    const p = loadPrefs();
    setPrefs(p);
    setDoc(blankDoc('receipt', p));
    setStamps(loadStamps());
    setBizOpen(!p.business.name);
    setBook((b) => ({ ...b, currency: p.currency, footer: p.footers.receipt }));
    setLedger(loadLedger());
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) saveLedger(ledger);
  }, [ledger, loaded]);
  useEffect(() => {
    if (loaded) savePrefs(prefs);
  }, [prefs, loaded]);

  const biz = prefs.business;
  const setBiz = <K extends keyof Business>(k: K, v: Business[K]) => setPrefs((p) => ({ ...p, business: { ...p.business, [k]: v }, businessAt: Date.now() }));

  // Sync with the person's account (docs/receipt-sync.md): the ledger, numbering and business profile on every device.
  const { status: syncStatus, syncNow } = useReceiptSync({
    ready: loaded,
    local: { entries: ledger, counters: prefs.counters, business: prefs.business, businessAt: prefs.businessAt ?? 0 },
    session: async () => {
      const s = await currentSession();
      if (!s) return null;
      return { user: s.user.id, post: (body) => api('/api/v1/me/receipt-sync', { auth: false, headers: { authorization: `Bearer ${s.access_token}` }, body }) };
    },
    onMerged: (m) => {
      const before = prefs.counters;
      // Applied to what is here now: anything changed while the sync ran is newer, so it is kept and sent next time.
      setLedger((l) => mergeEntries(l, m.entries));
      setPrefs((p) => {
        const a = applySync({ entries: [], counters: p.counters, business: p.business, businessAt: p.businessAt ?? 0 }, m);
        return { ...p, counters: a.counters, business: a.business, businessAt: a.businessAt };
      });
      // The document being written keeps its number unless another device has just used it.
      setDoc((d) =>
        d.number === docNumber(d.kind, before[d.kind] + 1) && m.counters[d.kind] > before[d.kind]
          ? { ...d, number: docNumber(d.kind, m.counters[d.kind] + 1) }
          : d,
      );
    },
  });
  const set = <K extends keyof BizDoc>(k: K, v: BizDoc[K]) => setDoc((d) => ({ ...d, [k]: v }));
  const setLine = (i: number, patch: Partial<Line>) => setDoc((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const sum = totals(doc);

  // The chosen Stamp Studio stamp and the PAID stamp, one impression per document number.
  const stampDesign = stamps.find((s) => s.id === prefs.stampId);
  const stampSrc = useMemo(
    () => (stampDesign ? renderStamp(stampDesign, { seed: seedOf(doc.number + stampDesign.id) }).src : undefined),
    [stampDesign, doc.number],
  );
  const paidSrc = useMemo(() => {
    if (!loaded || !prefs.paidStamp) return undefined;
    const d = newStamp({ ...TEMPLATES[2]!.design, numbered: false, bottom: (biz.name || '').toUpperCase().slice(0, 28), wear: 0.5 });
    return renderStamp(d, { seed: seedOf(doc.number), date: new Date(`${doc.date}T12:00:00`) }).src;
  }, [loaded, prefs.paidStamp, biz.name, doc.number, doc.date]);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const full: BizDoc = {
    ...doc,
    signature: prefs.signature,
    stamp: stampSrc,
    paidStamp: paidSrc,
    check: prefs.check ? { url: `${origin}/receipts/${PREVIEW_CODE}`, code: PREVIEW_CODE } : undefined,
  };

  // Live preview of the first page, rebuilt shortly after each change.
  useEffect(() => {
    if (!loaded || mode === 'ledger') return;
    let live = true;
    let pdfDoc: PDFDocumentProxy | undefined;
    const timer = setTimeout(async () => {
      try {
        // A book previews its first sheet only; the whole book is made on download.
        const bytes = mode === 'book' ? await buildBlankBook(biz, { ...book, count: bookTwoUp && !book.officeCopy ? 2 : 1 }) : await buildBizDoc(biz, full);
        pdfDoc = await openPdf(bytes);
        if (!live) return;
        if (mode === 'doc') setPages(pdfDoc.numPages);
        const page = await pdfDoc.getPage(1);
        const c = canvas.current;
        if (!c || !live) return;
        const max = mode === 'doc' && isSlip(full.size) ? 320 : 560;
        const width = Math.min(max, c.parentElement?.clientWidth ?? max);
        const vp1 = page.getViewport({ scale: 1 });
        const dpr = window.devicePixelRatio || 1;
        const vp = page.getViewport({ scale: (width / vp1.width) * dpr });
        c.width = vp.width;
        c.height = vp.height;
        c.style.width = `${width}px`;
        c.style.height = `${vp.height / dpr}px`;
        await page.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport: vp }).promise;
        setError(undefined);
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        void closePdf(pdfDoc);
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `full` is rebuilt from these on every render
  }, [loaded, mode, book, biz, doc, prefs.signature, prefs.check, stampSrc, paidSrc]);

  const problems = (): string | undefined => {
    if (!biz.name.trim()) return 'Add your business name first (Your business).';
    if (!doc.lines.some((l) => l.item.trim() && l.qty > 0)) return 'Add at least one item.';
    if (doc.kind !== 'receipt' && !doc.customer.trim()) return `Add who the ${doc.kind === 'invoice' ? 'invoice' : 'quotation'} is for.`;
    return undefined;
  };

  /** Builds the PDF after the Pro check, and remembers the number and the prices used. */
  async function finish(): Promise<{ bytes: Uint8Array; name: string } | undefined> {
    if (mode === 'book') return finishBook();
    const why = problems();
    if (why) {
      setError(why);
      return undefined;
    }
    if (!(await paid.require('receipts'))) return undefined;
    setBusy(true);
    try {
      const bytes = prefs.check ? await withCheck() : await buildBizDoc(biz, full);
      if (!bytes) return undefined;
      setLedger((l) => upsert(l, entryFromDoc(doc)));
      setPrefs((p) => afterDoc(p, doc));
      return { bytes, name: `${TITLES[doc.kind].modern} ${doc.number}${doc.customer ? ` - ${doc.customer}` : ''}.pdf`.replace(/[\\/:*?"<>|]+/g, ' ') };
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const bookCount = Math.min(BLANK_BOOK_MAX, Math.max(1, Math.floor(book.count) || 1));
  const bookSheets = Math.ceil((bookCount * (book.officeCopy ? 2 : 1)) / (bookTwoUp ? 2 : 1));

  /** The whole blank book, after the Pro check. */
  async function finishBook(): Promise<{ bytes: Uint8Array; name: string } | undefined> {
    if (!biz.name.trim()) {
      setError('Add your business name first (Your business).');
      return undefined;
    }
    if (!(await paid.require('receipts'))) return undefined;
    setBusy(true);
    try {
      const bytes = await buildBlankBook(biz, { ...book, count: bookCount });
      const first = docNumber(book.kind, book.start);
      const last = docNumber(book.kind, book.start + bookCount - 1);
      return { bytes, name: `${TITLES[book.kind].modern} book ${first}-${last}.pdf` };
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  /** The document with its check QR code (src/lib/receipts/check.ts), after sign-in. */
  async function withCheck(): Promise<Uint8Array | undefined> {
    const token = await sessionToken();
    if (!token) {
      setError(SIGN_IN);
      return undefined;
    }
    const post: Post = (path, body) => api(path, { auth: false, headers: { authorization: `Bearer ${token}` }, body });
    try {
      const out = await checkedPdf(biz, full, post, issued.current);
      issued.current = out.issued;
      return out.bytes;
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? SIGN_IN : `Could not add the check QR code: ${(e as Error).message}`);
      return undefined;
    }
  }

  async function download() {
    const out = await finish();
    if (!out) return;
    const url = URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: 'application/pdf' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: out.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  const canShare = typeof navigator !== 'undefined' && 'canShare' in navigator;
  async function share() {
    const out = await finish();
    if (!out) return;
    const file = new File([out.bytes as BlobPart], out.name, { type: 'application/pdf' });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: out.name });
      else setError('This browser cannot share files; use Download instead.');
    } catch {
      // The person closed the share sheet.
    }
  }
  /** Same customer, items and charges as a different kind of document (quotation → invoice → receipt). */
  const switchKind = (kind: DocKind) =>
    setDoc((d) => ({
      ...blankDoc(kind, prefs),
      customer: d.customer,
      customerDetails: d.customerDetails,
      lines: d.lines,
      discount: d.discount,
      delivery: d.delivery,
      gst: d.gst,
      style: d.style,
      size: d.size,
      currency: d.currency,
    }));

  /** Opens a receipt for a payment on an invoice from the ledger. */
  const recordPayment = (inv: LedgerEntry, balance: number) => {
    setDoc({
      ...blankDoc('receipt', prefs),
      customer: inv.customer,
      currency: inv.currency,
      against: inv.number,
      lines: [{ qty: 1, item: `Payment for invoice ${inv.number}`, rate: balance }],
    });
    setMode('doc');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const todayIso = iso(new Date());
  const payable = doc.kind === 'receipt' ? openInvoices(ledger, todayIso, doc.customer.trim() ? doc.customer : undefined) : [];

  const labels = {
    customer: doc.kind === 'receipt' ? 'Received from' : doc.kind === 'invoice' ? 'Bill to' : 'Prepared for',
    reference: doc.kind === 'invoice' ? 'Payment terms' : 'Their reference (optional)',
    until: doc.kind === 'invoice' ? 'Due date' : 'Valid until',
    notes: doc.kind === 'invoice' ? 'How to pay (bank account, mobile money number)' : 'Terms (validity, delivery, deposit)',
  };

  return (
    <div className={mode === 'ledger' ? 'rk rk-wide' : 'rk'}>
      <div className="rk-form">
        <span className="seg rk-mode" role="radiogroup" aria-label="What to make">
          <button type="button" role="radio" aria-checked={mode === 'doc'} className={mode === 'doc' ? 'on' : ''} onClick={() => setMode('doc')}>
            <FilePlus2 size={16} aria-hidden="true" /> Fill in a document
          </button>
          <button type="button" role="radio" aria-checked={mode === 'book'} className={mode === 'book' ? 'on' : ''} onClick={() => setMode('book')}>
            <BookOpen size={16} aria-hidden="true" /> Print a blank book
          </button>
          <button type="button" role="radio" aria-checked={mode === 'ledger'} className={mode === 'ledger' ? 'on' : ''} onClick={() => setMode('ledger')}>
            <ClipboardList size={16} aria-hidden="true" /> Sales ledger
          </button>
        </span>

        {mode === 'ledger' && (
          <LedgerView
            entries={ledger}
            setVoid={(e, v) => setLedger((l) => setVoid(l, e, v))}
            biz={biz}
            onPay={recordPayment}
            requirePaid={() => paid.require('receipts')}
            sync={syncStatus}
            onSync={() => void syncNow()}
          />
        )}

        {mode === 'book' && (
          <section className="rk-card">
            <h2>Blank receipt book</h2>
            <p className="muted rk-hint">
              Numbered pages with your letterhead, to print and fill in by hand, for the till, a market stall or work away from a computer.
            </p>
            <span className="seg" role="radiogroup" aria-label="Book of">
              {KINDS.map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={book.kind === k}
                  className={book.kind === k ? 'on' : ''}
                  onClick={() => setBook((b) => ({ ...b, kind: k, start: prefs.counters[k] + 1, footer: prefs.footers[k] }))}
                >
                  {label}
                </button>
              ))}
            </span>
            <div className="rk-row">
              <span className="seg" role="radiogroup" aria-label="Page size">
                {(
                  [
                    ['A5', 'A5'],
                    ['A4', 'A4'],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={book.size === v}
                    className={book.size === v ? 'on' : ''}
                    onClick={() => setB('size', v)}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>
            <div className="rk-grid">
              <label>
                First number
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={book.start || ''}
                  onChange={(e) => setB('start', Math.max(1, Math.floor(Number(e.target.value)) || 1))}
                />
              </label>
              <label>
                How many
                <input
                  type="number"
                  min={1}
                  max={BLANK_BOOK_MAX}
                  step={1}
                  value={book.count || ''}
                  onChange={(e) => setB('count', Math.min(BLANK_BOOK_MAX, Math.max(0, Math.floor(Number(e.target.value)) || 0)))}
                />
              </label>
              <label>
                Currency
                <select value={book.currency} onChange={(e) => setB('currency', e.target.value === 'USD' ? 'USD' : 'NLe')}>
                  <option value="NLe">New Leones (NLe)</option>
                  <option value="USD">US Dollars (USD)</option>
                </select>
              </label>
              {book.size === 'A5' && (
                <label className="check">
                  <input type="checkbox" checked={book.twoUp} onChange={(e) => setB('twoUp', e.target.checked)} /> Two on each A4 sheet (cut in half)
                </label>
              )}
              {book.kind === 'receipt' && (
                <label className="check">
                  <input type="checkbox" checked={book.counterfoil} onChange={(e) => setB('counterfoil', e.target.checked)} /> Counterfoil strip
                </label>
              )}
              <label className="check">
                <input type="checkbox" checked={book.officeCopy} onChange={(e) => setB('officeCopy', e.target.checked)} /> Office copy of each number
              </label>
              {book.kind !== 'receipt' && (
                <label className="span2">
                  {book.kind === 'invoice' ? 'How to pay, printed on every page (optional)' : 'Terms, printed on every page (optional)'}
                  <textarea rows={2} maxLength={300} value={book.notes} onChange={(e) => setB('notes', e.target.value)} />
                </label>
              )}
              <label className="span2">
                Footer message
                <textarea rows={2} maxLength={200} value={book.footer} onChange={(e) => setB('footer', e.target.value)} />
              </label>
            </div>
            <p className="rk-total">
              {docNumber(book.kind, book.start)} to {docNumber(book.kind, book.start + bookCount - 1)}{' '}
              <b>
                {bookSheets} {book.size === 'A5' && !bookTwoUp ? 'A5' : 'A4'} sheet{bookSheets === 1 ? '' : 's'}
              </b>
            </p>
            <p className="muted rk-hint">
              If you also make receipts here, start printed books at a different number (for example 5001) so the two never clash.
            </p>
          </section>
        )}

        {mode === 'doc' && (
          <section className="rk-card">
            <h2>Document</h2>
            <span className="seg" role="radiogroup" aria-label="Document">
              {KINDS.map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={doc.kind === k} className={doc.kind === k ? 'on' : ''} onClick={() => switchKind(k)}>
                  {label}
                </button>
              ))}
            </span>
            <div className="rk-row">
              {!isSlip(doc.size) && (
                <span className="seg" role="radiogroup" aria-label="Style">
                  {(
                    [
                      ['book', 'Receipt book'],
                      ['modern', 'Modern'],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      aria-checked={doc.style === v}
                      className={doc.style === v ? 'on' : ''}
                      onClick={() => {
                        set('style', v);
                        setPrefs((p) => ({ ...p, style: v }));
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              )}
              <span className="seg" role="radiogroup" aria-label="Paper size">
                {(
                  [
                    ['A4', 'A4'],
                    ['A5', 'A5'],
                    ['80mm', '80 mm slip'],
                    ['58mm', '58 mm slip'],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={doc.size === v}
                    className={doc.size === v ? 'on' : ''}
                    onClick={() => {
                      set('size', v);
                      setPrefs((p) => ({ ...p, size: v }));
                    }}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>
            {doc.kind === 'receipt' && (payable.length > 0 || doc.against) && (
              <label className="rk-against">
                Payment for invoice
                <select
                  value={doc.against ?? ''}
                  onChange={(e) => {
                    const hit = payable.find((x) => x.inv.number === e.target.value);
                    setDoc((d) => ({
                      ...d,
                      against: e.target.value || undefined,
                      ...(hit
                        ? {
                            customer: d.customer.trim() ? d.customer : hit.inv.customer,
                            // A payment is in the invoice's currency, or the ledger would count it against the wrong total.
                            currency: hit.inv.currency,
                            lines: d.lines.some((l) => l.item.trim())
                              ? d.lines
                              : [{ qty: 1, item: `Payment for invoice ${hit.inv.number}`, rate: hit.balance }],
                          }
                        : {}),
                    }));
                  }}
                >
                  <option value="">No, a cash sale</option>
                  {doc.against && !payable.some((x) => x.inv.number === doc.against) && <option value={doc.against}>{doc.against}</option>}
                  {payable.map((x) => (
                    <option key={x.inv.number} value={x.inv.number}>
                      {x.inv.number} · {x.inv.customer} · {x.inv.currency} {money(x.balance)} owed
                    </option>
                  ))}
                </select>
              </label>
            )}
            {isSlip(doc.size) && (
              <p className="muted rk-hint">
                For thermal receipt printers: one long slip in black. Signatures and stamps are left off; they print poorly on thermal paper.
              </p>
            )}
            <div className="rk-grid">
              <label>
                Number
                <input value={doc.number} maxLength={20} onChange={(e) => set('number', e.target.value)} />
              </label>
              <label>
                Date
                <input type="date" value={doc.date} onChange={(e) => set('date', e.target.value)} />
              </label>
              {doc.kind !== 'receipt' && (
                <label>
                  {labels.until}
                  <input type="date" value={doc.until} onChange={(e) => set('until', e.target.value)} />
                </label>
              )}
              <label>
                Currency
                <select
                  value={doc.currency}
                  onChange={(e) => {
                    const c = e.target.value === 'USD' ? 'USD' : 'NLe';
                    set('currency', c);
                    setPrefs((p) => ({ ...p, currency: c }));
                  }}
                >
                  <option value="NLe">New Leones (NLe)</option>
                  <option value="USD">US Dollars (USD)</option>
                </select>
              </label>
            </div>
          </section>
        )}

        {mode !== 'ledger' && (
          <details className="rk-card" open={bizOpen} onToggle={(e) => setBizOpen(e.currentTarget.open)}>
            <summary>
              <h2>Your business</h2>
              <span className="muted">{biz.name || 'Name, address, phones, logo and colours'}</span>
            </summary>
            <div className="rk-grid">
              <label className="span2">
                Business name
                <input value={biz.name} maxLength={80} onChange={(e) => setBiz('name', e.target.value)} placeholder="Kamara & Sons Hardware" />
              </label>
              <label className="span2">
                What you sell or do
                <input
                  value={biz.tagline}
                  maxLength={120}
                  onChange={(e) => setBiz('tagline', e.target.value)}
                  placeholder="Building materials · Hardware · General merchandise"
                />
              </label>
              <label className="span2">
                Address
                <input value={biz.address} maxLength={160} onChange={(e) => setBiz('address', e.target.value)} placeholder="14 Kissy Road, Freetown" />
              </label>
              <label>
                Phone numbers
                <input value={biz.phones} maxLength={80} onChange={(e) => setBiz('phones', e.target.value)} placeholder="+232 76 123 456" />
              </label>
              <label>
                Email (optional)
                <input value={biz.email} maxLength={80} onChange={(e) => setBiz('email', e.target.value)} />
              </label>
              <label>
                NRA TIN (optional)
                <input value={biz.tin} maxLength={30} onChange={(e) => setBiz('tin', e.target.value)} />
              </label>
              <div className="rk-colors">
                <label>
                  Main colour
                  <input type="color" value={biz.color} onChange={(e) => setBiz('color', e.target.value)} />
                </label>
                <label>
                  Accent
                  <input type="color" value={biz.accent} onChange={(e) => setBiz('accent', e.target.value)} />
                </label>
                {(biz.color !== DEFAULT_BUSINESS.color || biz.accent !== DEFAULT_BUSINESS.accent) && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setPrefs((p) => ({ ...p, business: { ...p.business, color: DEFAULT_BUSINESS.color, accent: DEFAULT_BUSINESS.accent } }))}
                  >
                    Navy and coral
                  </button>
                )}
              </div>
              <div className="rk-logo span2">
                {biz.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a local data: URL
                  <img src={biz.logo} alt="Your logo" />
                ) : null}
                <Button kind="ghost" onClick={() => logoInput.current?.click()}>
                  <ImagePlus size={16} aria-hidden="true" /> {biz.logo ? 'Change logo' : 'Add your logo'}
                </Button>
                {biz.logo && (
                  <Button kind="ghost" onClick={() => setBiz('logo', undefined)}>
                    Remove
                  </Button>
                )}
                <input
                  ref={logoInput}
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  aria-label="Logo"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    if (f.size > 5 * 1024 * 1024) return setError('Choose a logo smaller than 5 MB.');
                    setBiz('logo', await logoDataUrl(f));
                  }}
                />
              </div>
            </div>
          </details>
        )}

        {mode === 'doc' && (
          <>
            <section className="rk-card">
              <h2>{labels.customer}</h2>
              <div className="rk-grid">
                <label className="span2">
                  Customer name
                  <input value={doc.customer} maxLength={100} onChange={(e) => set('customer', e.target.value)} placeholder="Customer or company" />
                </label>
                <label className="span2">
                  Address or phone (optional)
                  <input value={doc.customerDetails} maxLength={160} onChange={(e) => set('customerDetails', e.target.value)} />
                </label>
                {doc.kind !== 'receipt' && (
                  <label className="span2">
                    {labels.reference}
                    <input value={doc.reference} maxLength={80} onChange={(e) => set('reference', e.target.value)} />
                  </label>
                )}
              </div>
            </section>

            <section className="rk-card">
              <h2>Items</h2>
              <datalist id="rk-items">
                {Object.keys(prefs.items).map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
              <div className="rk-lines">
                <div className="rk-line rk-line-head" aria-hidden="true">
                  <span>Qty</span>
                  <span>Description</span>
                  <span>Rate</span>
                  <span>Amount</span>
                  <span />
                </div>
                {doc.lines.map((l, i) => (
                  <div key={i} className="rk-line">
                    <input
                      type="number"
                      min={0}
                      step="any"
                      aria-label={`Quantity ${i + 1}`}
                      value={l.qty || ''}
                      onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })}
                    />
                    <input
                      aria-label={`Item ${i + 1}`}
                      list="rk-items"
                      maxLength={120}
                      value={l.item}
                      placeholder="Item or service"
                      onChange={(e) => {
                        const item = e.target.value;
                        const known = prefs.items[item];
                        setLine(i, known !== undefined && !l.rate ? { item, rate: known } : { item });
                      }}
                    />
                    <input
                      type="number"
                      min={0}
                      step="any"
                      aria-label={`Rate ${i + 1}`}
                      value={l.rate || ''}
                      onChange={(e) => setLine(i, { rate: Number(e.target.value) || 0 })}
                    />
                    <span className="rk-amount">{money(lineAmount(l))}</span>
                    <button
                      type="button"
                      className="ghost"
                      aria-label={`Remove item ${i + 1}`}
                      disabled={doc.lines.length === 1}
                      onClick={() => setDoc((d) => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }))}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
              <Button kind="ghost" onClick={() => setDoc((d) => ({ ...d, lines: [...d.lines, { qty: 1, item: '', rate: 0 }].slice(0, 60) }))}>
                <Plus size={16} aria-hidden="true" /> Add item
              </Button>
              <div className="rk-grid three">
                <label>
                  Discount
                  <input type="number" min={0} step="any" value={doc.discount || ''} onChange={(e) => set('discount', Number(e.target.value) || 0)} />
                </label>
                <label>
                  Delivery
                  <input type="number" min={0} step="any" value={doc.delivery || ''} onChange={(e) => set('delivery', Number(e.target.value) || 0)} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={doc.gst} onChange={(e) => set('gst', e.target.checked)} /> Add GST 15%
                </label>
              </div>
              <p className="rk-total">
                Total <b>{`${doc.currency} ${money(sum.total)}`}</b>
              </p>
              {doc.gst && <p className="muted rk-hint">GST-registered businesses must still give the NRA electronic cash register receipt for sales.</p>}
            </section>

            {doc.kind !== 'proforma' && (
              <section className="rk-card">
                <h2>Payment</h2>
                <div className="rk-grid">
                  {doc.kind === 'invoice' && (
                    <label>
                      Paid so far
                      <input type="number" min={0} step="any" value={doc.paid || ''} onChange={(e) => set('paid', Number(e.target.value) || 0)} />
                    </label>
                  )}
                  <label>
                    Paid by
                    <select value={doc.method} onChange={(e) => set('method', e.target.value as PayMethod)}>
                      {PAY_METHODS.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                  {doc.kind === 'receipt' && (
                    <label className="span2">
                      {doc.method === 'Cash' ? 'Reference (optional)' : 'Transaction ID and payer’s number'}
                      <input
                        value={doc.payRef}
                        maxLength={100}
                        onChange={(e) => set('payRef', e.target.value)}
                        placeholder={doc.method === 'Cash' ? '' : 'e.g. PP261026.1432.A71234 · 076 555 019'}
                      />
                    </label>
                  )}
                </div>
                {doc.kind === 'invoice' && (
                  <p className="rk-total">
                    Balance due <b>{`${doc.currency} ${money(sum.balance)}`}</b>
                  </p>
                )}
              </section>
            )}

            {doc.kind !== 'receipt' && (
              <section className="rk-card">
                <h2>{doc.kind === 'invoice' ? 'How to pay' : 'Terms'}</h2>
                <label>
                  {labels.notes}
                  <textarea rows={2} maxLength={300} value={doc.notes} onChange={(e) => set('notes', e.target.value)} />
                </label>
              </section>
            )}

            <section className="rk-card">
              <h2>Signature, stamp and footer</h2>
              <div className="rk-row wrap">
                <Button kind="ghost" onClick={() => setSigOpen(true)}>
                  {prefs.signature ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element -- a local data: URL */}
                      <img src={prefs.signature} alt="Your signature" className="sig-thumb" /> Change signature
                    </>
                  ) : (
                    'Add signature'
                  )}
                </Button>
                {prefs.signature && (
                  <Button kind="ghost" onClick={() => setPrefs((p) => ({ ...p, signature: undefined }))}>
                    Remove
                  </Button>
                )}
                <label className="inline">
                  Stamp
                  <select value={prefs.stampId} onChange={(e) => setPrefs((p) => ({ ...p, stampId: e.target.value }))}>
                    <option value="">No stamp</option>
                    {stamps.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button kind="ghost" onClick={() => setStudioOpen(true)}>
                  <StampIcon size={16} aria-hidden="true" /> Stamp Studio
                </Button>
              </div>
              <div className="rk-grid">
                <label>
                  Name under the signature
                  <input value={doc.signedBy} maxLength={60} onChange={(e) => set('signedBy', e.target.value)} />
                </label>
                {doc.kind !== 'proforma' && (
                  <label className="check">
                    <input type="checkbox" checked={prefs.paidStamp} onChange={(e) => setPrefs((p) => ({ ...p, paidStamp: e.target.checked }))} /> PAID stamp
                    when fully paid
                  </label>
                )}
                <label className="span2">
                  Footer message
                  <textarea rows={2} maxLength={200} value={doc.footer} onChange={(e) => set('footer', e.target.value)} />
                </label>
                {doc.style === 'book' && doc.kind === 'receipt' && !isSlip(doc.size) && (
                  <label className="check">
                    <input type="checkbox" checked={doc.counterfoil} onChange={(e) => set('counterfoil', e.target.checked)} /> Counterfoil strip
                  </label>
                )}
                <label className="check">
                  <input type="checkbox" checked={doc.officeCopy} onChange={(e) => set('officeCopy', e.target.checked)} /> Add an office copy
                </label>
              </div>
              <div className="rk-check">
                <input
                  id="rk-check"
                  type="checkbox"
                  aria-describedby="rk-check-why"
                  checked={prefs.check}
                  onChange={(e) => setPrefs((p) => ({ ...p, check: e.target.checked }))}
                />
                <div>
                  <label htmlFor="rk-check">
                    <QrCode size={15} aria-hidden="true" /> QR code to check it
                  </label>
                  <p id="rk-check-why" className="muted">
                    Anyone who scans it sees your business name, the number, date, total and customer name on rokelapdf.com, and whether you cancelled it. Needs
                    a free account; these details are sent when you download, the document itself is not.
                  </p>
                </div>
              </div>
            </section>
          </>
        )}
      </div>

      {mode !== 'ledger' && (
        <aside className="rk-preview" aria-label="Preview">
          <div className="rk-paper">
            <canvas
              ref={canvas}
              aria-label={
                mode === 'book'
                  ? `Preview of the first page of the ${TITLES[book.kind].modern.toLowerCase()} book`
                  : `Preview of ${TITLES[doc.kind].modern.toLowerCase()} ${doc.number}`
              }
            />
          </div>
          {mode === 'doc' && pages > 1 && <p className="muted rk-hint">{pages} pages · preview shows the first</p>}
          {mode === 'book' && <p className="muted rk-hint">Preview shows the first sheet. Print at 100% (actual size).</p>}
          {error === SIGN_IN ? (
            <p className="tool-error" role="alert">
              The check QR code needs a free Rokela PDF account. <Link href={`/signin?next=${encodeURIComponent('/receipts')}`}>Sign in or create one</Link>, or
              untick “QR code to check it”.
            </p>
          ) : (
            error && (
              <p className="tool-error" role="alert">
                {error}
              </p>
            )
          )}
          <div className="rk-actions">
            <Button kind="primary" onClick={download} disabled={busy}>
              <Download size={17} aria-hidden="true" /> {mode === 'book' ? `Download book (${bookSheets} sheet${bookSheets === 1 ? '' : 's'})` : 'Download PDF'}
            </Button>
            {canShare && (
              <Button onClick={share} disabled={busy}>
                <Share2 size={17} aria-hidden="true" /> Share
              </Button>
            )}
            {mode === 'doc' && (
              <Button
                kind="ghost"
                onClick={() => {
                  const p = { ...prefs, counters: { ...prefs.counters, [doc.kind]: Math.max(prefs.counters[doc.kind], numberOf(doc.number)) } };
                  setPrefs(p);
                  setDoc({ ...blankDoc(doc.kind, p), style: doc.style, size: doc.size, currency: doc.currency });
                }}
              >
                <FilePlus2 size={17} aria-hidden="true" /> Next {doc.kind === 'proforma' ? 'quotation' : doc.kind}
              </Button>
            )}
          </div>
          <p className="muted rk-hint">Made on this device: your business details, numbers and prices stay in this browser.</p>
        </aside>
      )}

      <SignaturePad
        open={sigOpen}
        onClose={() => setSigOpen(false)}
        onDone={(sig) => {
          setPrefs((p) => ({ ...p, signature: sig.src }));
          setSigOpen(false);
        }}
      />
      <StampStudio
        open={studioOpen}
        current={stampDesign}
        onClose={() => {
          setStudioOpen(false);
          setStamps(loadStamps());
        }}
        onUse={(d) => {
          setStamps(loadStamps());
          setPrefs((p) => ({ ...p, stampId: d.id }));
          setStudioOpen(false);
        }}
      />
      {paid.prompt}
    </div>
  );
}
