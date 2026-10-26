'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FilePlus2, ImagePlus, Plus, Share2, Stamp as StampIcon, Trash2 } from 'lucide-react';
import { usePaid } from '@/components/paid';
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
  money,
  totals,
  type BizDoc,
  type Business,
  type DocKind,
  type Line,
  type PayMethod,
} from '@/lib/receipts/model';
import { buildBizDoc } from '@/lib/receipts/pdf';
import { DEFAULT_PREFS, loadPrefs, savePrefs, type ReceiptPrefs } from '@/lib/receipts/store';
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
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
const numberOf = (s: string) => Number(/(\d+)\D*$/.exec(s)?.[1] ?? 0);
/** A stable number from text, so a document keeps the same stamp impression while it is edited. */
const seedOf = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

function blankDoc(kind: DocKind, p: ReceiptPrefs): BizDoc {
  return {
    kind,
    style: p.style,
    size: p.size,
    currency: p.currency,
    number: docNumber(kind, p.counters[kind] + 1),
    date: iso(new Date()),
    until: kind === 'invoice' ? inDays(30) : kind === 'proforma' ? inDays(14) : '',
    customer: '',
    customerDetails: '',
    reference: kind === 'invoice' ? 'Credit, 30 days' : '',
    lines: [{ qty: 1, item: '', rate: 0 }],
    discount: 0,
    delivery: 0,
    gst: false,
    paid: 0,
    method: 'Cash',
    payRef: '',
    notes: '',
    footer: p.footers[kind],
    counterfoil: true,
    officeCopy: false,
    signedBy: p.signedBy,
  };
}

/** Shrinks a chosen logo so it stays small in saved settings and in every document. */
async function logoDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 320 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

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
  const canvas = useRef<HTMLCanvasElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  // Settings are read once in the browser (they are not available while the page is rendered on the server).
  useEffect(() => {
    const p = loadPrefs();
    setPrefs(p);
    setDoc(blankDoc('receipt', p));
    setStamps(loadStamps());
    setBizOpen(!p.business.name);
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) savePrefs(prefs);
  }, [prefs, loaded]);

  const biz = prefs.business;
  const setBiz = <K extends keyof Business>(k: K, v: Business[K]) => setPrefs((p) => ({ ...p, business: { ...p.business, [k]: v } }));
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

  const full: BizDoc = { ...doc, signature: prefs.signature, stamp: stampSrc, paidStamp: paidSrc };

  // Live preview of the first page, rebuilt shortly after each change.
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    let pdfDoc: PDFDocumentProxy | undefined;
    const timer = setTimeout(async () => {
      try {
        const bytes = await buildBizDoc(biz, full);
        pdfDoc = await openPdf(bytes);
        if (!live) return;
        setPages(pdfDoc.numPages);
        const page = await pdfDoc.getPage(1);
        const c = canvas.current;
        if (!c || !live) return;
        const width = Math.min(560, c.parentElement?.clientWidth ?? 560);
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
  }, [loaded, biz, doc, prefs.signature, stampSrc, paidSrc]);

  const problems = (): string | undefined => {
    if (!biz.name.trim()) return 'Add your business name first (Your business).';
    if (!doc.lines.some((l) => l.item.trim() && l.qty > 0)) return 'Add at least one item.';
    if (doc.kind !== 'receipt' && !doc.customer.trim()) return `Add who the ${doc.kind === 'invoice' ? 'invoice' : 'quotation'} is for.`;
    return undefined;
  };

  /** Builds the PDF after the Pro check, and remembers the number and the prices used. */
  async function finish(): Promise<{ bytes: Uint8Array; name: string } | undefined> {
    const why = problems();
    if (why) {
      setError(why);
      return undefined;
    }
    if (!(await paid.require('receipts'))) return undefined;
    setBusy(true);
    try {
      const bytes = await buildBizDoc(biz, full);
      setPrefs((p) => {
        const items = { ...p.items };
        for (const l of doc.lines) if (l.item.trim() && l.rate > 0) items[l.item.trim().slice(0, 120)] = l.rate;
        return {
          ...p,
          counters: { ...p.counters, [doc.kind]: Math.max(p.counters[doc.kind], numberOf(doc.number)) },
          items: Object.fromEntries(Object.entries(items).slice(-300)),
          footers: { ...p.footers, [doc.kind]: doc.footer },
          signedBy: doc.signedBy,
        };
      });
      return { bytes, name: `${TITLES[doc.kind].modern} ${doc.number}${doc.customer ? ` - ${doc.customer}` : ''}.pdf`.replace(/[\\/:*?"<>|]+/g, ' ') };
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
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

  const labels = {
    customer: doc.kind === 'receipt' ? 'Received from' : doc.kind === 'invoice' ? 'Bill to' : 'Prepared for',
    reference: doc.kind === 'invoice' ? 'Payment terms' : 'Their reference (optional)',
    until: doc.kind === 'invoice' ? 'Due date' : 'Valid until',
    notes: doc.kind === 'invoice' ? 'How to pay (bank account, mobile money number)' : 'Terms (validity, delivery, deposit)',
  };

  return (
    <div className="rk">
      <div className="rk-form">
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
            <span className="seg" role="radiogroup" aria-label="Paper size">
              {(['A4', 'A5'] as const).map((v) => (
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
                  {v}
                </button>
              ))}
            </span>
          </div>
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
                <span className="rk-amount">{money(l.qty * l.rate)}</span>
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
                <input type="checkbox" checked={prefs.paidStamp} onChange={(e) => setPrefs((p) => ({ ...p, paidStamp: e.target.checked }))} /> PAID stamp when
                fully paid
              </label>
            )}
            <label className="span2">
              Footer message
              <textarea rows={2} maxLength={200} value={doc.footer} onChange={(e) => set('footer', e.target.value)} />
            </label>
            {doc.style === 'book' && doc.kind === 'receipt' && (
              <label className="check">
                <input type="checkbox" checked={doc.counterfoil} onChange={(e) => set('counterfoil', e.target.checked)} /> Counterfoil strip
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={doc.officeCopy} onChange={(e) => set('officeCopy', e.target.checked)} /> Add an office copy
            </label>
          </div>
        </section>
      </div>

      <aside className="rk-preview" aria-label="Preview">
        <div className="rk-paper">
          <canvas ref={canvas} aria-label={`Preview of ${TITLES[doc.kind].modern.toLowerCase()} ${doc.number}`} />
        </div>
        {pages > 1 && <p className="muted rk-hint">{pages} pages · preview shows the first</p>}
        {error && (
          <p className="tool-error" role="alert">
            {error}
          </p>
        )}
        <div className="rk-actions">
          <Button kind="primary" onClick={download} disabled={busy}>
            <Download size={17} aria-hidden="true" /> Download PDF
          </Button>
          {canShare && (
            <Button onClick={share} disabled={busy}>
              <Share2 size={17} aria-hidden="true" /> Share
            </Button>
          )}
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
        </div>
        <p className="muted rk-hint">Made on this device: your business details, numbers and prices stay in this browser.</p>
      </aside>

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
