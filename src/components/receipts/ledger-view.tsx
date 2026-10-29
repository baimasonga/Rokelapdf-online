'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Cloud, CloudOff, Copy, Download, FileSpreadsheet, HandCoins, RotateCcw, Search, XCircle } from 'lucide-react';
import { syncedAgo, type SyncStatus } from '@/lib/receipts/use-sync';
import { Button } from '@/components/ui';
import { customers, entryKey, invoiceState, ledgerCsv, statement, summary, type LedgerEntry } from '@/lib/receipts/ledger';
import { money, shortDate, type Business, type Currency } from '@/lib/receipts/model';
import { buildStatement } from '@/lib/receipts/pdf';

// The sales ledger screen of the Receipt Maker (src/lib/receipts/ledger.ts): totals for a period, who owes what,
// customer statements, and every document made, to find by customer, number or date and, when it was kept in full
// (src/lib/receipts/docs.ts), download again or copy into a new one.

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
type Period = 'month' | 'last' | 'year' | 'all';
type Filter = 'all' | 'unpaid' | 'receipt' | 'proforma';
const PAGE = 100;

function range(p: Period, entries: LedgerEntry[], today: Date): [string, string] {
  const y = today.getFullYear();
  const m = today.getMonth();
  if (p === 'month') return [iso(new Date(y, m, 1)), iso(today)];
  if (p === 'last') return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
  if (p === 'year') return [iso(new Date(y, 0, 1)), iso(today)];
  const first = entries.reduce((a, e) => (e.date < a ? e.date : a), iso(today));
  return [first, iso(today)];
}

function download(bytes: Uint8Array | string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const STATUS: Record<string, [string, string]> = {
  paid: ['Paid', 'ok'],
  part: ['Part paid', 'info'],
  unpaid: ['Unpaid', ''],
  overdue: ['Overdue', 'danger'],
};

export function LedgerView(props: {
  entries: LedgerEntry[];
  setVoid: (e: LedgerEntry, value: boolean) => void;
  biz: Business;
  /** Opens a receipt for a payment on this invoice. */
  onPay: (inv: LedgerEntry, balance: number) => void;
  /** Keys of the documents kept in full, which can be downloaded again or copied. */
  saved: Set<string>;
  onAgain: (e: LedgerEntry) => Promise<void>;
  onCopy: (e: LedgerEntry) => void;
  requirePaid: () => boolean | Promise<boolean>;
  /** Sync with the person's account (docs/receipt-sync.md). */
  sync: SyncStatus;
  onSync: () => void;
}) {
  const { entries, biz } = props;
  const [currency, setCurrency] = useState<Currency>(() => (entries[0]?.currency === 'USD' ? 'USD' : 'NLe'));
  const [period, setPeriod] = useState<Period>('month');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<string>();
  const now = new Date();
  const today = iso(now);
  const [from, to] = range(period, entries, now);

  const sum = useMemo(() => summary(entries, currency, from, to, today), [entries, currency, from, to, today]);
  const people = useMemo(() => customers(entries, currency, today), [entries, currency, today]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) => {
      if (e.currency !== currency) return false;
      if (needle && !`${e.number} ${e.customer} ${shortDate(e.date)} ${e.date}`.toLowerCase().includes(needle)) return false;
      if (filter === 'unpaid') return e.kind === 'invoice' && !e.void && invoiceState(entries, e, today).balance > 0;
      if (filter === 'receipt' || filter === 'proforma') return e.kind === filter;
      return true;
    });
  }, [entries, currency, q, filter, today]);

  async function statementFor(name: string) {
    if (!(await props.requirePaid())) return;
    try {
      const st = statement(entries, name, currency, from, to);
      download(await buildStatement(biz, st, today), `Statement - ${st.customer} - ${to}.pdf`.replace(/[\\/:*?"<>|]+/g, ' '), 'application/pdf');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function exportCsv() {
    if (!(await props.requirePaid())) return;
    download(ledgerCsv(entries, today), `Sales ledger ${today}.csv`, 'text/csv');
  }

  if (!entries.length)
    return (
      <section className="rk-card rk-ledger-empty">
        <h2>Sales ledger</h2>
        <p>Every receipt, invoice and quotation you download or share appears here, so you can see your sales, who owes you, and send customers a statement.</p>
        <p className="muted">Make an invoice to start. To record a payment on it later, choose “Record payment” here.</p>
        <SyncLine sync={props.sync} onSync={props.onSync} />
      </section>
    );

  const tiles: Array<[string, number, string]> = [
    ['Sales', sum.sales, ''],
    ['Received', sum.received, ''],
    ['Owed to you', sum.outstanding, 'Today, on all invoices'],
    ['Overdue', sum.overdue, 'Past the due date'],
  ];
  return (
    <div className="rk-ledger">
      <div className="rk-ledger-bar">
        <span className="seg" role="radiogroup" aria-label="Period">
          {(
            [
              ['month', 'This month'],
              ['last', 'Last month'],
              ['year', 'This year'],
              ['all', 'All time'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={period === v} className={period === v ? 'on' : ''} onClick={() => setPeriod(v)}>
              {label}
            </button>
          ))}
        </span>
        <label className="inline">
          Currency
          <select value={currency} onChange={(e) => setCurrency(e.target.value === 'USD' ? 'USD' : 'NLe')}>
            <option value="NLe">NLe</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <Button kind="ghost" onClick={exportCsv}>
          <FileSpreadsheet size={16} aria-hidden="true" /> Export CSV
        </Button>
      </div>
      <p className="muted rk-hint">
        {shortDate(from)} – {shortDate(to)} · {sum.documents} document{sum.documents === 1 ? '' : 's'}
      </p>

      <div className="rk-tiles">
        {tiles.map(([label, n, hint], i) => (
          <div key={label} className={`rk-tile${i === 3 && n > 0 ? ' alert' : ''}`}>
            <span>{label}</span>
            <b>
              {currency} {money(n)}
            </b>
            {hint && <small>{hint}</small>}
          </div>
        ))}
      </div>
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}

      <section className="rk-card">
        <h2>Customers</h2>
        {people.length ? (
          <div className="table-wrap">
            <table className="rk-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th className="num">Owes</th>
                  <th className="num">Overdue</th>
                  <th>Last activity</th>
                  <th aria-label="Statement" />
                </tr>
              </thead>
              <tbody>
                {people.slice(0, 50).map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td className="num">{money(c.owed)}</td>
                    <td className={`num${c.overdue > 0 ? ' late' : ''}`}>{money(c.overdue)}</td>
                    <td>{shortDate(c.last)}</td>
                    <td className="act">
                      <Button kind="ghost" onClick={() => statementFor(c.name)}>
                        <Download size={15} aria-hidden="true" /> Statement
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No invoices in {currency} yet. Customers with invoices appear here, with what they owe.</p>
        )}
        <p className="muted rk-hint">Statements cover the period chosen above, with the opening balance before it.</p>
      </section>

      <section className="rk-card">
        <h2>Documents</h2>
        <div className="rk-ledger-bar">
          <span className="seg" role="radiogroup" aria-label="Show">
            {(
              [
                ['all', 'All'],
                ['unpaid', 'Unpaid invoices'],
                ['receipt', 'Receipts'],
                ['proforma', 'Quotations'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={filter === v} className={filter === v ? 'on' : ''} onClick={() => setFilter(v)}>
                {label}
              </button>
            ))}
          </span>
          <label className="rk-search">
            <Search size={15} aria-hidden="true" />
            <input type="search" placeholder="Customer, number or date" aria-label="Search documents" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
        <div className="table-wrap">
          <table className="rk-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Number</th>
                <th>Customer</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((e) => {
                const inv = e.kind === 'invoice' && !e.void ? invoiceState(entries, e, today) : undefined;
                const [label, tone] = e.void
                  ? ['Cancelled', '']
                  : inv
                    ? STATUS[inv.status]!
                    : e.kind === 'proforma'
                      ? ['Quotation', '']
                      : e.against
                        ? [`Payment · ${e.against}`, 'ok']
                        : ['Cash sale', 'ok'];
                return (
                  <tr key={`${e.kind} ${e.number}`} className={e.void ? 'void' : ''}>
                    <td>{shortDate(e.date)}</td>
                    <td>{e.number}</td>
                    <td>{e.customer || <span className="muted">—</span>}</td>
                    <td className="num">{money(e.total)}</td>
                    <td>
                      <span className={`badge ${tone}`}>{label}</span>
                      {inv && inv.balance > 0 && inv.paid > 0 && <small className="muted"> {money(inv.balance)} left</small>}
                    </td>
                    <td className="act">
                      {props.saved.has(entryKey(e)) && (
                        <>
                          <Button
                            kind="ghost"
                            title={`Download ${e.number} again`}
                            onClick={() => props.onAgain(e).catch((x) => setError((x as Error).message))}
                          >
                            <Download size={15} aria-hidden="true" /> Download
                          </Button>
                          <Button kind="ghost" title={`A new document with the same customer and items as ${e.number}`} onClick={() => props.onCopy(e)}>
                            <Copy size={15} aria-hidden="true" /> Copy
                          </Button>
                        </>
                      )}
                      {inv && inv.balance > 0 && (
                        <Button kind="ghost" onClick={() => props.onPay(e, inv.balance)}>
                          <HandCoins size={15} aria-hidden="true" /> Record payment
                        </Button>
                      )}
                      <Button
                        kind="ghost"
                        title={e.void ? 'Count this document again' : 'Leave this document out of every total'}
                        onClick={() => {
                          if (e.void || window.confirm(`Cancel ${e.number}? It stays listed but no longer counts in any total.`)) props.setVoid(e, !e.void);
                        }}
                      >
                        {e.void ? <RotateCcw size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />} {e.void ? 'Restore' : 'Cancel'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!rows.length && <p className="muted">Nothing matches.</p>}
        {rows.length > shown && (
          <Button kind="ghost" onClick={() => setShown((n) => n + PAGE)}>
            Show more ({rows.length - shown} left)
          </Button>
        )}
      </section>
      <SyncLine sync={props.sync} onSync={props.onSync} />
    </div>
  );
}

/** Where the ledger is kept: in step with the account, or only in this browser. */
function SyncLine({ sync, onSync }: { sync: SyncStatus; onSync: () => void }) {
  if (sync.k === 'signed-out')
    return (
      <p className="muted rk-hint rk-sync">
        <CloudOff size={15} aria-hidden="true" /> Kept in this browser only. <Link href={`/signin?next=${encodeURIComponent('/receipts')}`}>Sign in</Link> to
        keep your businesses, documents and ledger on all your devices, including the Android app.
      </p>
    );
  if (sync.k === 'error')
    return (
      <p className="muted rk-hint rk-sync">
        <CloudOff size={15} aria-hidden="true" /> Not synced: {sync.message}{' '}
        <button type="button" className="link" onClick={onSync}>
          Try again
        </button>
      </p>
    );
  return (
    <p className="muted rk-hint rk-sync" role="status">
      <Cloud size={15} aria-hidden="true" /> {sync.k === 'syncing' ? 'Syncing with your account…' : `Synced with your account ${syncedAgo(sync.at)}.`}
    </p>
  );
}
