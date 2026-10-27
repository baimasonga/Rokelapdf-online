import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { ArrowLeft, Building2, FilePlus2, HandCoins, ImagePlus, Plus, RotateCcw, Save, Share2, Trash2, XCircle } from 'lucide-react';
import {
  PAY_METHODS,
  TITLES,
  isSlip,
  lineAmount,
  money,
  shortDate,
  totals,
  type BizDoc,
  type Business,
  type DocKind,
  type PageSize,
  type PayMethod,
} from '@/lib/receipts/model';
import { buildBizDoc, buildStatement } from '@/lib/receipts/pdf';
import { afterDoc, isoDate, loadPrefs, logoDataUrl, newDoc, savePrefs, type ReceiptPrefs } from '@/lib/receipts/store';
import {
  customers,
  entryFromDoc,
  invoiceState,
  ledgerCsv,
  loadLedger,
  openInvoices,
  saveLedger,
  setVoid,
  statement,
  summary,
  upsert,
  type LedgerEntry,
} from '@/lib/receipts/ledger';
import { TEMPLATES, newStamp } from '@/lib/stamp/design';
import { renderStamp } from '@/lib/stamp/render';
import { PDF_MIME, saveFile, shareFile } from './native';
import { SITE, currentSession } from './account';
import { PREVIEW_CODE, checkedPdf, type Issued, type Post } from '@/lib/receipts/check';
import { openPdf, renderPage } from './pdf';
import { SignaturePad } from './sign';
import { AppBar, IconButton, Sheet } from './ui';

// Receipts on the phone: cash receipts, invoices and quotations in the same layouts as the website's Receipt Maker
// (src/lib/receipts), shared straight to WhatsApp or saved, with the sales ledger and customer statements. Everything
// is made and kept on the phone; making a document is a Pro feature (src/lib/licensing.ts).

const KINDS: Array<[DocKind, string]> = [
  ['receipt', 'Receipt'],
  ['invoice', 'Invoice'],
  ['proforma', 'Quotation'],
];
const SIZES: Array<[PageSize, string]> = [
  ['A4', 'A4'],
  ['A5', 'A5'],
  ['80mm', '80 mm slip'],
  ['58mm', '58 mm slip'],
];
/** A stable number from text, so a document keeps the same stamp impression while it is edited. */
const seedOf = (s: string) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
const fileName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ');
const STATUS: Record<string, string> = { paid: 'Paid', part: 'Part paid', unpaid: 'Unpaid', overdue: 'Overdue' };

const DRAFT = 'rokela.receipts.draft';
/** The document being written, kept so it survives signing in, a phone call or the app being closed. */
function loadDraft(): BizDoc | undefined {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT) ?? 'null') as Partial<BizDoc> | null;
    if (!d || (d.kind !== 'receipt' && d.kind !== 'invoice' && d.kind !== 'proforma') || !Array.isArray(d.lines)) return undefined;
    const lines = d.lines
      .filter((l) => l && typeof l.item === 'string' && Number.isFinite(l.qty) && Number.isFinite(l.rate))
      .map((l) => ({ qty: l.qty, item: l.item.slice(0, 120), rate: l.rate }))
      .slice(0, 60);
    return {
      ...newDoc(d.kind, loadPrefs()),
      ...d,
      lines: lines.length ? lines : [{ qty: 1, item: '', rate: 0 }],
      signature: undefined,
      stamp: undefined,
      paidStamp: undefined,
      check: undefined,
    };
  } catch {
    return undefined;
  }
}
function saveDraft(doc: BizDoc) {
  try {
    localStorage.setItem(DRAFT, JSON.stringify(doc));
  } catch {
    /* storage full or unavailable: the draft is just not kept */
  }
}

export function Receipts(props: {
  onBack: () => void;
  /** Runs work behind the progress overlay; errors are shown by the app. */
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  /** Runs `go` once the Pro check passes, or shows why not. */
  paid: (go: () => void) => void;
  setError: (m: string) => void;
  setNotice: (m: string) => void;
  /** Opens sign-in (for the check QR code); the app comes back to this screen afterwards. */
  signIn: () => void;
  /** Android's Back button: set to a handler that closes this screen's own sheets first (true when it did). */
  backRef: MutableRefObject<(() => boolean) | undefined>;
}) {
  const { run, setError, setNotice } = props;
  const [prefs, setPrefs] = useState<ReceiptPrefs>(loadPrefs);
  const [doc, setDoc] = useState<BizDoc>(() => loadDraft() ?? newDoc('receipt', loadPrefs()));
  /** The check QR code needs an account: asks the person to sign in, keeping the draft. */
  const [needSignIn, setNeedSignIn] = useState(false);
  const issued = useRef<Issued>(undefined);
  const [ledger, setLedger] = useState<LedgerEntry[]>(loadLedger);
  const [tab, setTab] = useState<'new' | 'ledger'>('new');
  const [bizOpen, setBizOpen] = useState(() => !loadPrefs().business.name);
  const [more, setMore] = useState(false);
  const [pad, setPad] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  useEffect(() => savePrefs(prefs), [prefs]);
  const { backRef } = props;
  useEffect(() => {
    backRef.current = () => {
      if (pad) return (setPad(false), true);
      if (needSignIn) return (setNeedSignIn(false), true);
      if (bizOpen) return (setBizOpen(false), true);
      return false;
    };
    return () => {
      backRef.current = undefined;
    };
  }, [backRef, pad, bizOpen, needSignIn]);
  useEffect(() => saveLedger(ledger), [ledger]);
  useEffect(() => saveDraft(doc), [doc]);

  const biz = prefs.business;
  const setBiz = <K extends keyof Business>(k: K, v: Business[K]) => setPrefs((p) => ({ ...p, business: { ...p.business, [k]: v } }));
  const set = <K extends keyof BizDoc>(k: K, v: BizDoc[K]) => setDoc((d) => ({ ...d, [k]: v }));
  const setLine = (i: number, patch: Partial<BizDoc['lines'][number]>) =>
    setDoc((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const sum = totals(doc);
  const today = isoDate(new Date());
  const payable = doc.kind === 'receipt' ? openInvoices(ledger, today, doc.customer.trim() ? doc.customer : undefined) : [];

  const paidSrc = useMemo(() => {
    if (!prefs.paidStamp) return undefined;
    const d = newStamp({ ...TEMPLATES[2]!.design, numbered: false, bottom: (biz.name || '').toUpperCase().slice(0, 28), wear: 0.5 });
    return renderStamp(d, { seed: seedOf(doc.number), date: new Date(`${doc.date}T12:00:00`) }).src;
  }, [prefs.paidStamp, biz.name, doc.number, doc.date]);
  const full: BizDoc = {
    ...doc,
    signature: prefs.signature,
    paidStamp: paidSrc,
    check: prefs.check ? { url: `${SITE}/receipts/${PREVIEW_CODE}`, code: PREVIEW_CODE } : undefined,
  };

  // Live preview of the first page, rebuilt shortly after each change.
  useEffect(() => {
    if (tab !== 'new') return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const pdf = await openPdf(await buildBizDoc(biz, full));
        try {
          const c = canvas.current;
          if (live && c) await renderPage(pdf.doc, 1, c, Math.min(isSlip(full.size) ? 260 : 420, (c.parentElement?.clientWidth ?? 360) - 2));
        } finally {
          void pdf.close();
        }
      } catch {
        // The preview is a convenience; making the document reports real errors.
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `full` is rebuilt from these on every render
  }, [tab, biz, doc, prefs.signature, prefs.check, paidSrc]);

  const problem = (): string | undefined => {
    if (!biz.name.trim()) return 'Add your business name first.';
    if (!doc.lines.some((l) => l.item.trim() && l.qty > 0)) return 'Add at least one item.';
    if (doc.kind !== 'receipt' && !doc.customer.trim()) return `Add who the ${doc.kind === 'invoice' ? 'invoice' : 'quotation'} is for.`;
    return undefined;
  };

  /** Makes the PDF after the Pro check, records it in the ledger, then shares or saves it. */
  const finish = (how: 'share' | 'save') => {
    const why = problem();
    if (why) {
      if (!biz.name.trim()) setBizOpen(true);
      return setError(why);
    }
    props.paid(
      () =>
        void run('Making the PDF…', async () => {
          const bytes = prefs.check ? await withCheck() : await buildBizDoc(biz, full);
          if (!bytes) return;
          const name = fileName(`${TITLES[doc.kind].modern} ${doc.number}${doc.customer.trim() ? ` - ${doc.customer.trim()}` : ''}.pdf`);
          // Only a document that was actually shared or saved is recorded and uses up its number; cancelling the
          // share sheet (it rejects) or the Save-to dialog (it returns false) leaves the ledger as it was.
          if (how === 'share') await shareFile(name, bytes, PDF_MIME);
          else if (!(await saveFile(name, bytes, PDF_MIME))) return;
          setLedger((l) => upsert(l, entryFromDoc(doc)));
          setPrefs((p) => afterDoc(p, doc));
          if (how === 'save') setNotice(`Saved ${name}.`);
        }),
    );
  };
  /** The document with its check QR code (src/lib/receipts/check.ts); undefined when the person must sign in first. */
  async function withCheck(): Promise<Uint8Array | undefined> {
    const session = await currentSession();
    if (!session) return void setNeedSignIn(true);
    let signedOut = false;
    const post: Post = async (path, body) => {
      let res: Response;
      try {
        res = await fetch(`${SITE}${path}`, {
          method: 'POST',
          credentials: 'omit',
          headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        throw new Error('The check QR code needs the internet. Connect, or untick “QR code to check it”.');
      }
      if (res.status === 401) {
        signedOut = true;
        throw new Error('Sign in again.');
      }
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) throw new Error(`Could not add the check QR code: ${j?.message ?? 'try again later'}.`);
      return j as never;
    };
    try {
      const out = await checkedPdf(biz, full, post, issued.current);
      issued.current = out.issued;
      return out.bytes;
    } catch (e) {
      if (signedOut) return void setNeedSignIn(true);
      throw e;
    }
  }

  const next = () => {
    const p = afterDoc(prefs, doc);
    setPrefs(p);
    setDoc({ ...newDoc(doc.kind, p), size: doc.size, style: doc.style, currency: doc.currency });
    window.scrollTo({ top: 0 });
  };
  const switchKind = (kind: DocKind) =>
    setDoc((d) => ({
      ...newDoc(kind, prefs),
      customer: d.customer,
      lines: d.lines,
      discount: d.discount,
      delivery: d.delivery,
      gst: d.gst,
      size: d.size,
      style: d.style,
      currency: d.currency,
    }));
  const recordPayment = (inv: LedgerEntry, balance: number) => {
    setDoc({
      ...newDoc('receipt', prefs),
      customer: inv.customer,
      currency: inv.currency,
      against: inv.number,
      lines: [{ qty: 1, item: `Payment for invoice ${inv.number}`, rate: balance }],
    });
    setTab('new');
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <AppBar
        left={<IconButton icon={ArrowLeft} label="Back" onClick={props.onBack} />}
        title="Receipts"
        subtitle={biz.name || 'Receipts, invoices and quotations'}
        right={<IconButton icon={Building2} label="Your business" onClick={() => setBizOpen(true)} />}
      />
      <main className="rcpt">
        <div className="seg" role="radiogroup" aria-label="Receipts">
          <button role="radio" aria-checked={tab === 'new'} className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>
            New document
          </button>
          <button role="radio" aria-checked={tab === 'ledger'} className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>
            Sales ledger
          </button>
        </div>

        {tab === 'new' ? (
          <>
            <section className="card">
              <div className="seg" role="radiogroup" aria-label="Document">
                {KINDS.map(([k, label]) => (
                  <button key={k} role="radio" aria-checked={doc.kind === k} className={doc.kind === k ? 'on' : ''} onClick={() => switchKind(k)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="rcpt-two">
                <label>
                  Number
                  <input value={doc.number} maxLength={20} onChange={(e) => set('number', e.target.value)} />
                </label>
                <label>
                  Date
                  <input type="date" value={doc.date} onChange={(e) => set('date', e.target.value)} />
                </label>
              </div>
              <label>
                {doc.kind === 'receipt' ? 'Received from' : doc.kind === 'invoice' ? 'Bill to' : 'Prepared for'}
                <input value={doc.customer} maxLength={100} placeholder="Customer name" onChange={(e) => set('customer', e.target.value)} />
              </label>
              {doc.kind === 'receipt' && (payable.length > 0 || doc.against) ? (
                <label>
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
                    {doc.against && !payable.some((x) => x.inv.number === doc.against) ? <option value={doc.against}>{doc.against}</option> : null}
                    {payable.map((x) => (
                      <option key={x.inv.number} value={x.inv.number}>
                        {x.inv.number} · {x.inv.customer} · {money(x.balance)} owed
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {doc.kind !== 'receipt' ? (
                <label>
                  {doc.kind === 'invoice' ? 'Due date' : 'Valid until'}
                  <input type="date" value={doc.until} onChange={(e) => set('until', e.target.value)} />
                </label>
              ) : null}
            </section>

            <section className="card">
              <h2>Items</h2>
              <datalist id="rcpt-items">
                {Object.keys(prefs.items).map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
              {doc.lines.map((l, i) => (
                <div key={i} className="rcpt-line">
                  <input
                    aria-label={`Item ${i + 1}`}
                    className="rcpt-item"
                    list="rcpt-items"
                    maxLength={120}
                    placeholder="Item or service"
                    value={l.item}
                    onChange={(e) => {
                      const item = e.target.value;
                      const known = prefs.items[item];
                      setLine(i, known !== undefined && !l.rate ? { item, rate: known } : { item });
                    }}
                  />
                  <input
                    aria-label={`Quantity ${i + 1}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={l.qty || ''}
                    onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })}
                  />
                  <span aria-hidden="true">×</span>
                  <input
                    aria-label={`Price ${i + 1}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    placeholder="Price"
                    value={l.rate || ''}
                    onChange={(e) => setLine(i, { rate: Number(e.target.value) || 0 })}
                  />
                  <b>{money(lineAmount(l))}</b>
                  <IconButton
                    icon={Trash2}
                    label={`Remove item ${i + 1}`}
                    disabled={doc.lines.length === 1}
                    onClick={() => setDoc((d) => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }))}
                  />
                </div>
              ))}
              <button className="ghost pill" onClick={() => setDoc((d) => ({ ...d, lines: [...d.lines, { qty: 1, item: '', rate: 0 }].slice(0, 60) }))}>
                <Plus size={18} aria-hidden="true" /> Add item
              </button>
              <p className="rcpt-total">
                Total{' '}
                <b>
                  {doc.currency} {money(sum.total)}
                </b>
              </p>
            </section>

            {doc.kind !== 'proforma' ? (
              <section className="card">
                <h2>Payment</h2>
                <div className="rcpt-two">
                  <label>
                    Paid by
                    <select value={doc.method} onChange={(e) => set('method', e.target.value as PayMethod)}>
                      {PAY_METHODS.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                  {doc.kind === 'invoice' ? (
                    <label>
                      Paid so far
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        value={doc.paid || ''}
                        onChange={(e) => set('paid', Number(e.target.value) || 0)}
                      />
                    </label>
                  ) : null}
                </div>
                {doc.kind === 'receipt' && doc.method !== 'Cash' ? (
                  <label>
                    Transaction ID and payer’s number
                    <input value={doc.payRef} maxLength={100} onChange={(e) => set('payRef', e.target.value)} />
                  </label>
                ) : null}
              </section>
            ) : null}

            <section className="card">
              <div className="rcpt-two">
                <label>
                  Paper
                  <select
                    value={doc.size}
                    onChange={(e) => {
                      const v = e.target.value as PageSize;
                      set('size', v);
                      setPrefs((p) => ({ ...p, size: v }));
                    }}
                  >
                    {SIZES.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {!isSlip(doc.size) ? (
                  <label>
                    Style
                    <select
                      value={doc.style}
                      onChange={(e) => {
                        const v = e.target.value === 'book' ? 'book' : 'modern';
                        set('style', v);
                        setPrefs((p) => ({ ...p, style: v }));
                      }}
                    >
                      <option value="modern">Modern</option>
                      <option value="book">Receipt book</option>
                    </select>
                  </label>
                ) : null}
              </div>
              {isSlip(doc.size) ? <p className="muted rcpt-hint">For thermal receipt printers: share the slip to your printer’s app.</p> : null}
              <button className="link rcpt-more" aria-expanded={more} onClick={() => setMore((m) => !m)}>
                {more ? 'Fewer options' : 'More options: discount, GST, signature, footer'}
              </button>
              {more ? (
                <div className="form-fields">
                  <div className="rcpt-two">
                    <label>
                      Discount
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        value={doc.discount || ''}
                        onChange={(e) => set('discount', Number(e.target.value) || 0)}
                      />
                    </label>
                    <label>
                      Delivery
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        value={doc.delivery || ''}
                        onChange={(e) => set('delivery', Number(e.target.value) || 0)}
                      />
                    </label>
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={doc.gst} onChange={(e) => set('gst', e.target.checked)} /> Add GST 15%
                  </label>
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
                  {doc.kind !== 'receipt' ? (
                    <label>
                      {doc.kind === 'invoice' ? 'How to pay (bank, mobile money number)' : 'Terms'}
                      <textarea rows={2} maxLength={300} value={doc.notes} onChange={(e) => set('notes', e.target.value)} />
                    </label>
                  ) : null}
                  <label>
                    Name under the signature
                    <input value={doc.signedBy} maxLength={60} onChange={(e) => set('signedBy', e.target.value)} />
                  </label>
                  <div className="row">
                    <button className="ghost pill" onClick={() => setPad(true)}>
                      {prefs.signature ? 'Change signature' : 'Add signature'}
                    </button>
                    {prefs.signature ? (
                      <button className="link" onClick={() => setPrefs((p) => ({ ...p, signature: undefined }))}>
                        Remove
                      </button>
                    ) : null}
                  </div>
                  {doc.kind !== 'proforma' ? (
                    <label className="check">
                      <input type="checkbox" checked={prefs.paidStamp} onChange={(e) => setPrefs((p) => ({ ...p, paidStamp: e.target.checked }))} /> PAID stamp
                      when fully paid
                    </label>
                  ) : null}
                  <label>
                    Footer message
                    <textarea rows={2} maxLength={200} value={doc.footer} onChange={(e) => set('footer', e.target.value)} />
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={doc.officeCopy} onChange={(e) => set('officeCopy', e.target.checked)} /> Add an office copy
                  </label>
                  <label className="check rcpt-check">
                    <input type="checkbox" checked={prefs.check} onChange={(e) => setPrefs((p) => ({ ...p, check: e.target.checked }))} />
                    <span>
                      QR code to check it
                      <small className="muted">
                        Anyone who scans it sees your business name, the number, date, total and customer on rokelapdf.com. Needs the internet and a free
                        account; the document itself is not sent.
                      </small>
                    </span>
                  </label>
                </div>
              ) : null}
            </section>

            <div className="rcpt-preview">
              <canvas ref={canvas} aria-label={`Preview of ${TITLES[doc.kind].modern.toLowerCase()} ${doc.number}`} />
            </div>
            <div className="rcpt-actions">
              <button className="primary pill" onClick={() => finish('share')}>
                <Share2 size={18} aria-hidden="true" /> Share
              </button>
              <button className="ghost pill" onClick={() => finish('save')}>
                <Save size={18} aria-hidden="true" /> Save
              </button>
              <button className="ghost pill" onClick={next}>
                <FilePlus2 size={18} aria-hidden="true" /> Next
              </button>
            </div>
            <p className="note">Made on this phone. Your business details, numbers and prices stay on this phone.</p>
          </>
        ) : (
          <Ledger
            entries={ledger}
            biz={biz}
            currency={prefs.currency}
            onPay={recordPayment}
            onVoid={(e, v) => setLedger((l) => setVoid(l, e, v))}
            paid={props.paid}
            run={run}
          />
        )}
      </main>

      {bizOpen ? (
        <Sheet title="Your business" onClose={() => setBizOpen(false)}>
          <div className="form-fields rcpt-biz">
            <label>
              Business name
              <input value={biz.name} maxLength={80} onChange={(e) => setBiz('name', e.target.value)} placeholder="e.g. Kamara & Sons Hardware" />
            </label>
            <label>
              What you sell (optional)
              <input value={biz.tagline} maxLength={120} onChange={(e) => setBiz('tagline', e.target.value)} />
            </label>
            <label>
              Address
              <input value={biz.address} maxLength={160} onChange={(e) => setBiz('address', e.target.value)} />
            </label>
            <label>
              Phone numbers
              <input value={biz.phones} maxLength={80} inputMode="tel" onChange={(e) => setBiz('phones', e.target.value)} />
            </label>
            <div className="rcpt-two">
              <label>
                Email
                <input value={biz.email} maxLength={80} type="email" onChange={(e) => setBiz('email', e.target.value)} />
              </label>
              <label>
                TIN
                <input value={biz.tin} maxLength={30} onChange={(e) => setBiz('tin', e.target.value)} />
              </label>
            </div>
            <div className="rcpt-two">
              <label>
                Main colour
                <input type="color" value={biz.color} onChange={(e) => setBiz('color', e.target.value)} />
              </label>
              <label>
                Accent
                <input type="color" value={biz.accent} onChange={(e) => setBiz('accent', e.target.value)} />
              </label>
            </div>
            <div className="row">
              <button className="ghost pill" onClick={() => logoInput.current?.click()}>
                <ImagePlus size={18} aria-hidden="true" /> {biz.logo ? 'Change logo' : 'Add logo'}
              </button>
              {biz.logo ? (
                <button className="link" onClick={() => setBiz('logo', undefined)}>
                  Remove logo
                </button>
              ) : null}
            </div>
            <input
              ref={logoInput}
              type="file"
              accept="image/png,image/jpeg"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (f.size > 5 * 1024 * 1024) return setError('Choose a logo smaller than 5 MB.');
                try {
                  setBiz('logo', await logoDataUrl(f));
                } catch {
                  setError('That picture could not be read.');
                }
              }}
            />
            <button className="primary pill" onClick={() => setBizOpen(false)}>
              Done
            </button>
          </div>
        </Sheet>
      ) : null}
      {needSignIn ? (
        <Sheet title="Sign in for the check QR code" onClose={() => setNeedSignIn(false)}>
          <p className="muted">The QR code is registered on rokelapdf.com under your account. Your document is kept here while you sign in.</p>
          <div className="row">
            <button className="ghost pill" onClick={() => setNeedSignIn(false)}>
              Not now
            </button>
            <button
              className="primary pill"
              onClick={() => {
                setNeedSignIn(false);
                props.signIn();
              }}
            >
              Sign in
            </button>
          </div>
        </Sheet>
      ) : null}
      {pad ? (
        <SignaturePad
          onCancel={() => setPad(false)}
          onDone={(s) => {
            setPrefs((p) => ({ ...p, signature: s.src }));
            setPad(false);
          }}
        />
      ) : null}
    </>
  );
}

function Ledger(props: {
  entries: LedgerEntry[];
  biz: Business;
  currency: 'NLe' | 'USD';
  onPay: (inv: LedgerEntry, balance: number) => void;
  onVoid: (e: LedgerEntry, value: boolean) => void;
  paid: (go: () => void) => void;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const { entries, currency } = props;
  const now = new Date();
  const today = isoDate(now);
  const from = isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const [shown, setShown] = useState(50);
  const sum = useMemo(() => summary(entries, currency, from, today, today), [entries, currency, from, today]);
  const people = useMemo(() => customers(entries, currency, today), [entries, currency, today]);

  if (!entries.length)
    return (
      <div className="empty">
        <HandCoins size={32} aria-hidden="true" />
        <p>Every receipt, invoice and quotation you share or save appears here, so you can see your sales and who owes you.</p>
      </div>
    );

  const firstDate = entries.reduce((a, e) => (e.date < a ? e.date : a), today);
  const sendStatement = (name: string) =>
    props.paid(
      () =>
        void props.run('Making the statement…', async () => {
          const st = statement(entries, name, currency, firstDate, today);
          await shareFile(fileName(`Statement - ${st.customer} - ${today}.pdf`), await buildStatement(props.biz, st, today), PDF_MIME);
        }),
    );
  const exportCsv = () =>
    props.paid(
      () =>
        void props.run('Preparing…', async () => {
          await shareFile(`Sales ledger ${today}.csv`, new TextEncoder().encode(ledgerCsv(entries, today)), 'text/csv');
        }),
    );

  return (
    <>
      <div className="rcpt-tiles">
        <div>
          <span>Sales this month</span>
          <b>{money(sum.sales)}</b>
        </div>
        <div>
          <span>Received this month</span>
          <b>{money(sum.received)}</b>
        </div>
        <div>
          <span>Owed to you</span>
          <b>{money(sum.outstanding)}</b>
        </div>
        <div className={sum.overdue > 0 ? 'late' : ''}>
          <span>Overdue</span>
          <b>{money(sum.overdue)}</b>
        </div>
      </div>
      <p className="muted rcpt-hint">Amounts in {currency}.</p>

      {people.length ? (
        <section className="card">
          <h2>Customers</h2>
          {people.slice(0, 30).map((c) => (
            <div key={c.name} className="rcpt-entry">
              <div>
                <strong>{c.name}</strong>
                <span className={c.overdue > 0 ? 'late' : 'muted'}>
                  {c.owed > 0 ? `Owes ${money(c.owed)}${c.overdue > 0 ? ` · ${money(c.overdue)} overdue` : ''}` : 'Nothing owed'}
                </span>
              </div>
              <button className="ghost pill small" onClick={() => sendStatement(c.name)}>
                Statement
              </button>
            </div>
          ))}
        </section>
      ) : null}

      <section className="card">
        <h2>Documents</h2>
        {entries.slice(0, shown).map((e) => {
          const inv = e.kind === 'invoice' && !e.void ? invoiceState(entries, e, today) : undefined;
          const status = e.void
            ? 'Cancelled'
            : inv
              ? `${STATUS[inv.status]}${inv.balance > 0 && inv.paid > 0 ? ` · ${money(inv.balance)} left` : ''}`
              : e.kind === 'proforma'
                ? 'Quotation'
                : e.against
                  ? `Payment for ${e.against}`
                  : 'Cash sale';
          return (
            <div key={`${e.kind} ${e.number}`} className={`rcpt-entry${e.void ? ' void' : ''}`}>
              <div>
                <strong>
                  {e.number} · {e.currency} {money(e.total)}
                </strong>
                <span className={inv?.status === 'overdue' ? 'late' : 'muted'}>
                  {shortDate(e.date)}
                  {e.customer ? ` · ${e.customer}` : ''} · {status}
                </span>
              </div>
              {inv && inv.balance > 0 ? (
                <button className="ghost pill small" onClick={() => props.onPay(e, inv.balance)}>
                  Record payment
                </button>
              ) : null}
              <IconButton
                icon={e.void ? RotateCcw : XCircle}
                label={e.void ? `Restore ${e.number}` : `Cancel ${e.number}`}
                onClick={() => {
                  if (e.void || window.confirm(`Cancel ${e.number}? It stays listed but no longer counts in any total.`)) props.onVoid(e, !e.void);
                }}
              />
            </div>
          );
        })}
        {entries.length > shown ? (
          <button className="link" onClick={() => setShown((n) => n + 50)}>
            Show more
          </button>
        ) : null}
      </section>
      <button className="ghost pill" onClick={exportCsv}>
        Export to a spreadsheet (CSV)
      </button>
      <p className="note">The ledger is kept on this phone only. Export it now and then to keep a copy.</p>
    </>
  );
}
