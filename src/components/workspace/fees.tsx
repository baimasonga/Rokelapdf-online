'use client';
import { useMemo, useState } from 'react';
import { Badge, Button, CopyField, Details, Empty, Form, Modal, Muted, Panel, Table, confirmAction } from '@/components/ui';
import { api, apiBlob, enc } from '@/lib/client/api';
import { downloadCsv } from '@/lib/client/csv';
import { inDays, splitList, when } from '@/lib/client/format';
import { sha256Hex } from '@/lib/client/sha256';
import { STATEMENT_BATCH, formatAmount } from '@/lib/fees/match';
import { guessColumns, readStatement, statementLines, type Columns, type Grid } from '@/lib/fees/statement';
import { ownerDownload, useLoad, useWs } from './context';
/* eslint-disable @typescript-eslint/no-explicit-any */

// Fee clearance (docs/fee-clearance.md): students claim bank payments through a fee desk; finance matches them against
// the bank statement (read on this device) and issues verified clearance certificates.

const CERTIFICATE_BATCH = 50;
const REJECT_REASONS: Array<[string, string]> = [
  ['not_on_statement', 'Not on the bank statement'],
  ['amount_differs', 'Amount does not match'],
  ['duplicate', 'Payment already used'],
  ['unreadable_receipt', 'Receipt unreadable'],
  ['other', 'Other'],
];
const STATUS_TEXT: Record<string, string> = {
  submitted: 'Waiting for the statement',
  matched: 'Payment confirmed',
  cleared: 'Certificate issued',
  rejected: 'Rejected',
};

function save(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function FeeClearance() {
  const { nav, P, workspace } = useWs();
  if (workspace.kind !== 'team')
    return (
      <Panel title="Fee clearance">
        <Empty>Fee clearance runs from a team workspace, so certificates name your institution. Create or switch to a team.</Empty>
      </Panel>
    );
  return nav.id ? <FeeDesk key={`${P}:${nav.id}`} id={nav.id} /> : <FeeDeskList key={P} />;
}

function FeeDeskList() {
  const { P, go } = useWs();
  const { data, error } = useLoad<any>(() => api(`${P}/fee-desks`), [P]);
  const { data: overview } = useLoad<any>(() => api(`${P}/overview`), [P]);
  const available = overview && overview.limits.upload_requests && overview.limits.verified_documents;
  return (
    <>
      <Panel title="Open a fee desk">
        <p>
          Students enter their student ID and the details on their bank receipt, and upload a photo of it. You then upload the bank&apos;s statement: payments
          are matched by reference, amount and date, and each cleared student gets a certificate with a QR code that registry, exams, hostel and library staff
          can scan.
        </p>
        {!overview ? (
          <Muted>Loading…</Muted>
        ) : !available ? (
          <p>Fee clearance needs upload requests and verified documents, which are not included in this workspace&apos;s plan.</p>
        ) : (
          <Form
            fields={[
              { name: 'title', label: 'What is being cleared', placeholder: '2026/27 first semester tuition' },
              {
                name: 'banks',
                label: 'Banks students pay into',
                placeholder: 'Rokel Commercial Bank, Sierra Leone Commercial Bank',
                hint: 'Separate bank names with commas. Students choose one; you import each bank’s statement separately.',
              },
              {
                name: 'currency',
                label: 'Currency',
                type: 'select',
                options: [
                  ['NLe', 'Leones (NLe)'],
                  ['USD', 'US dollars (USD)'],
                ],
              },
              { name: 'amount_due', label: 'Fee due', optional: true, placeholder: '1500.00', hint: 'No certificate is issued for a smaller payment.' },
              { name: 'days', label: 'Accept claims for (days)', type: 'number', value: '60', min: 1, max: 366 },
              {
                name: 'tolerance',
                label: 'Days a statement date may differ',
                type: 'number',
                value: '3',
                min: 0,
                max: 31,
                hint: 'Banks often record a payment a day or two after the receipt date.',
              },
              { name: 'password', label: 'Page password', type: 'password', optional: true, autoComplete: 'new-password' },
              { name: 'notify', label: 'Email me when a claim arrives', type: 'checkbox' },
            ]}
            submit="Open fee desk"
            onSubmit={async (f) => {
              const banks = splitList(f.banks);
              if (!banks.length) throw new Error('List at least one bank.');
              const d = await api(`${P}/fee-desks`, {
                body: {
                  title: f.title,
                  banks,
                  currency: f.currency,
                  ...(f.amount_due ? { amount_due: f.amount_due } : {}),
                  deadline: inDays(f.days || 60),
                  date_tolerance_days: Number(f.tolerance || 3),
                  ...(f.password ? { password: f.password } : {}),
                  notify: f.notify === 'yes',
                },
              });
              go('fees', d.id);
            }}
          />
        )}
      </Panel>
      <Panel title="Fee desks">
        {error ? (
          <p role="alert">{error.message}</p>
        ) : !data ? (
          <Muted>Loading…</Muted>
        ) : data.items.length ? (
          <Table
            head={['Desk', 'Accepting claims until', 'State', '']}
            rows={data.items.map((d: any) => [
              d.title,
              when(d.request.deadline),
              <Badge key="s" state={d.request.accepting ? 'open' : 'closed'} />,
              <Button key="o" onClick={() => go('fees', d.id)}>
                Open
              </Button>,
            ])}
          />
        ) : (
          <Empty>No fee desks yet.</Empty>
        )}
      </Panel>
    </>
  );
}

function FeeDesk({ id }: { id: string }) {
  const { P, go, workspace } = useWs();
  const base = `${P}/fee-desks/${enc(id)}`;
  const { data: d, error, reload } = useLoad<any>(() => api(base), [base]);
  const [filter, setFilter] = useState('open');
  const [q, setQ] = useState('');
  const [approving, setApproving] = useState<any>();
  const [rejecting, setRejecting] = useState<any>();
  const [issuing, setIssuing] = useState('');
  const claims = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (d?.claims ?? []).filter(
      (c: any) =>
        (filter === 'all' || (filter === 'open' ? c.status === 'submitted' || c.status === 'matched' : c.status === filter)) &&
        (!term || [c.student_name, c.student_id, c.reference].some((s: string) => s.toLowerCase().includes(term))),
    );
  }, [d, filter, q]);
  if (error) return <Panel title="Fee desk">{error.message}</Panel>;
  if (!d) return <Muted>Loading…</Muted>;
  const money = (n: number) => formatAmount(n, d.currency);
  const matched = d.claims.filter((c: any) => c.status === 'matched' && (d.amount_due === null || c.amount >= d.amount_due));

  const issueAll = async () => {
    if (!confirmAction(`Issue ${matched.length} clearance certificate${matched.length === 1 ? '' : 's'}? Each one is public at its QR code.`)) return;
    let done = 0;
    const skipped: string[] = [];
    for (let i = 0; i < matched.length; i += CERTIFICATE_BATCH) {
      setIssuing(`Issuing ${i + 1}–${Math.min(i + CERTIFICATE_BATCH, matched.length)} of ${matched.length}…`);
      const r = await api(`${base}/certificates`, { body: { claim_ids: matched.slice(i, i + CERTIFICATE_BATCH).map((c: any) => c.id) } });
      done += r.issued.length;
      skipped.push(...r.skipped.map((s: any) => s.reason));
    }
    setIssuing(`${done} certificate${done === 1 ? '' : 's'} issued.${skipped.length ? ` ${skipped.length} skipped: ${[...new Set(skipped)].join('; ')}` : ''}`);
    reload();
  };

  return (
    <>
      <Panel
        title={d.title}
        actions={
          <Button kind="ghost" onClick={() => go('fees')}>
            ← All fee desks
          </Button>
        }
      >
        <CopyField value={d.request.url} label="Link for students" />
        <Details
          items={[
            ['Accepting claims', d.request.accepting ? `Yes, until ${when(d.request.deadline)}` : 'No'],
            ['Banks', d.banks.join(', ')],
            ['Fee due', d.amount_due === null ? 'Any amount' : money(d.amount_due)],
            ['Statement date may differ by', `${d.date_tolerance_days} day${d.date_tolerance_days === 1 ? '' : 's'}`],
            ['Claims', `${d.counts.submitted} waiting · ${d.counts.matched} confirmed · ${d.counts.cleared} cleared · ${d.counts.rejected} rejected`],
          ]}
        />
        {d.request.status === 'purged' ? (
          <p className="muted">The receipt photos were deleted with the upload request. Claims and certificates are kept.</p>
        ) : (
          <div className="actions">
            <Button onClick={() => go('requests', d.request.id)}>Upload request settings</Button>
          </div>
        )}
      </Panel>
      {!d.claims_visible ? (
        <Panel title="Claims">
          <p className="muted">Only the person who opened this desk and the workspace owners and admins can see students&apos; payments.</p>
        </Panel>
      ) : (
        <>
          <StatementImport desk={d} base={base} onDone={reload} />
          <Panel
            title="Claims"
            actions={
              <>
                <Button
                  onClick={() =>
                    downloadCsv(`${d.title.replace(/[^A-Za-z0-9]+/g, '-')}-claims.csv`, [
                      ['Student name', 'Student ID', 'Bank', 'Reference', 'Amount', 'Paid on', 'Status', 'Confirmed by', 'Certificate code', 'Submitted'],
                      ...d.claims.map((c: any) => [
                        c.student_name,
                        c.student_id,
                        c.bank,
                        c.reference,
                        (c.amount / 100).toFixed(2),
                        c.paid_on,
                        c.status,
                        c.match_method ?? '',
                        c.certificate?.code ?? '',
                        c.submitted_at,
                      ]),
                    ])
                  }
                >
                  Export CSV
                </Button>
                <Button kind="primary" disabled={!matched.length || issuing.startsWith('Issuing')} onClick={issueAll}>
                  Issue {matched.length || ''} certificate{matched.length === 1 ? '' : 's'}
                </Button>
              </>
            }
          >
            {issuing && <p role="status">{issuing}</p>}
            <div className="row">
              <label htmlFor="fee-filter">
                <span>Show</span>
                <select id="fee-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="open">To do (waiting or confirmed)</option>
                  <option value="submitted">Waiting for the statement</option>
                  <option value="matched">Payment confirmed</option>
                  <option value="cleared">Certificate issued</option>
                  <option value="rejected">Rejected</option>
                  <option value="all">All</option>
                </select>
              </label>
              <label htmlFor="fee-q">
                <span>Search</span>
                <input id="fee-q" value={q} placeholder="Name, student ID or reference" onChange={(e) => setQ(e.target.value)} />
              </label>
            </div>
            <p className="muted">Names, student IDs and receipts are entered by students. Only the bank statement confirms a payment.</p>
            {claims.length ? (
              <Table
                head={['Student', 'Payment', 'Receipt', 'Status', '']}
                rows={claims.map((c: any) => [
                  <span key="s">
                    <strong>{c.student_name}</strong>
                    <br />
                    <span className="muted small">{c.student_id}</span>
                  </span>,
                  <span key="p">
                    {money(c.amount)} · {c.paid_on}
                    <br />
                    <span className="muted small">
                      {c.bank} · {c.reference}
                    </span>
                    {d.amount_due !== null && c.amount < d.amount_due && <span className="muted small"> · less than the fee due</span>}
                  </span>,
                  <span key="r">
                    {c.receipts.map((f: any) =>
                      f.status === 'available' ? (
                        <Button key={f.id} kind="ghost" onClick={() => ownerDownload(workspace.id, 'submission_file', f.id)}>
                          {f.name}
                        </Button>
                      ) : (
                        <span key={f.id} className="muted small">
                          {f.name} ({f.status})
                        </span>
                      ),
                    )}
                  </span>,
                  <span key="st">
                    <Badge state={c.certificate?.status === 'revoked' ? 'certificate revoked' : c.status === 'matched' ? 'confirmed' : c.status} />
                    <br />
                    <span className="muted small">
                      {c.status === 'matched' || c.status === 'cleared'
                        ? c.match_method === 'statement'
                          ? `On ${c.statement_line.file_name}, ${c.statement_line.date}${c.statement_line.student_id_found ? ', with the student ID' : ''}`
                          : `Confirmed by hand: ${c.match_note}`
                        : c.status === 'rejected'
                          ? (REJECT_REASONS.find(([k]) => k === c.rejection_reason)?.[1] ?? '')
                          : (c.match_issue ?? STATUS_TEXT[c.status])}
                    </span>
                  </span>,
                  <span key="a" className="actions">
                    {c.status === 'submitted' && <Button onClick={() => setApproving(c)}>Confirm</Button>}
                    {(c.status === 'submitted' || c.status === 'matched') && (
                      <Button kind="danger" onClick={() => setRejecting(c)}>
                        Reject
                      </Button>
                    )}
                    {c.certificate && (
                      <>
                        <Button
                          onClick={async () =>
                            save(
                              `fee-clearance-${c.student_id.replace(/[^A-Za-z0-9_-]+/g, '-')}.pdf`,
                              await apiBlob(`${P}/fee-claims/${enc(c.id)}/certificate`),
                            )
                          }
                        >
                          Certificate
                        </Button>
                        <a href={c.certificate.url} target="_blank" rel="noreferrer">
                          Check page
                        </a>
                      </>
                    )}
                  </span>,
                ])}
              />
            ) : (
              <Empty>{d.claims.length ? 'No claims match.' : 'No claims yet. Share the link for students.'}</Empty>
            )}
          </Panel>
        </>
      )}
      <Modal open={!!approving} onClose={() => setApproving(undefined)} title="Confirm payment by hand">
        {approving && (
          <>
            <p>
              Confirm the payment of <strong>{money(approving.amount)}</strong> by {approving.student_name} ({approving.bank}, {approving.reference}) only after
              checking it with the bank, for example in its online portal. Your note is kept in the audit log and the certificate says the finance office
              confirmed it.
            </p>
            <Form
              fields={[{ name: 'note', label: 'How you confirmed it', placeholder: 'Seen in the RCB portal on 5 October' }]}
              submit="Confirm payment"
              onSubmit={async (f) => {
                await api(`${P}/fee-claims/${enc(approving.id)}/approve`, { body: { note: f.note } });
                setApproving(undefined);
                reload();
              }}
            />
          </>
        )}
      </Modal>
      <Modal open={!!rejecting} onClose={() => setRejecting(undefined)} title="Reject claim">
        {rejecting && (
          <>
            <p>
              Rejecting {rejecting.student_name}&apos;s claim is final. The student sees the reason on their status page, and the bank reference can be claimed
              again, for example by the person who really paid.
            </p>
            <Form
              fields={[
                { name: 'reason', label: 'Reason', type: 'select', options: REJECT_REASONS },
                { name: 'message', label: 'Message to the student', type: 'textarea', optional: true },
              ]}
              submit="Reject claim"
              kind="danger"
              onSubmit={async (f) => {
                await api(`${P}/fee-claims/${enc(rejecting.id)}/reject`, { body: { reason: f.reason, ...(f.message ? { message: f.message } : {}) } });
                setRejecting(undefined);
                reload();
              }}
            />
          </>
        )}
      </Modal>
    </>
  );
}

const FIELDS: Array<[keyof Columns, string, boolean]> = [
  ['date', 'Date', true],
  ['amount', 'Credit (money in)', true],
  ['reference', 'Reference', true],
  ['description', 'Description', false],
];

/** Reads the statement here; only its credit lines (date, amount, reference, description) are sent for matching. */
function StatementImport({ desk, base, onDone }: { desk: any; base: string; onDone: () => void }) {
  const [file, setFile] = useState<{ name: string; sha256: string; grid: Grid }>();
  const [header, setHeader] = useState(0);
  const [columns, setColumns] = useState<Columns>({ date: -1, amount: -1, reference: -1, description: -1, signed: false });
  const [monthFirst, setMonthFirst] = useState(false);
  const [bank, setBank] = useState<string>(desk.banks[0]);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<{ lines: number; matched: number; issues: number; open: number }>();
  const [problem, setProblem] = useState('');
  const heads = file?.grid[header] ?? [];
  const preview = useMemo(
    () => (file && columns.date >= 0 && columns.amount >= 0 && columns.reference >= 0 ? statementLines(file.grid, header, columns, monthFirst) : undefined),
    [file, header, columns, monthFirst],
  );

  const choose = async (f: File | undefined) => {
    setResult(undefined);
    setProblem('');
    setFile(undefined);
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const grid = readStatement(f.name, bytes);
      const guess = guessColumns(grid);
      setHeader(guess?.header ?? 0);
      setColumns(guess?.columns ?? { date: -1, amount: -1, reference: -1, description: -1, signed: false });
      setFile({ name: f.name, sha256: await sha256Hex(bytes), grid });
      // A file named after the bank ("slcb-october.csv", "Rokel statement.xlsx") selects it; the officer can still change it.
      const file = f.name.toLowerCase();
      const named = desk.banks.find((b: string) => {
        const words = b.toLowerCase().split(/\s+/).filter(Boolean);
        const initials = words.map((w) => w[0]).join('');
        const key = words.find((w) => !['bank', 'the', 'of', 'and', '&'].includes(w));
        return (!!key && key.length >= 3 && file.includes(key)) || (initials.length >= 2 && new RegExp(`(^|[^a-z])${initials}([^a-z]|$)`).test(file));
      });
      if (named) setBank(named);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  const run = async () => {
    if (!file || !preview) return;
    const total = { lines: 0, matched: 0, issues: 0, open: 0 };
    const matchedIds = new Set<string>();
    const issueIds = new Set<string>();
    try {
      for (let i = 0; i < preview.lines.length; i += STATEMENT_BATCH) {
        setBusy(`Matching lines ${i + 1}–${Math.min(i + STATEMENT_BATCH, preview.lines.length)} of ${preview.lines.length}…`);
        const r = await api(`${base}/statements`, {
          body: { bank, file_name: file.name.slice(0, 200), file_sha256: file.sha256, lines: preview.lines.slice(i, i + STATEMENT_BATCH) },
        });
        total.lines += r.lines;
        for (const m of r.matched) matchedIds.add(m.claim_id);
        for (const x of r.issues) issueIds.add(x.claim_id);
        total.open = r.still_open;
      }
      total.matched = matchedIds.size;
      total.issues = [...issueIds].filter((x) => !matchedIds.has(x)).length;
      setResult(total);
      onDone();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <Panel title="Match a bank statement">
      <p className="muted">
        Download the account statement from the bank as CSV or Excel (.xlsx). It is read on this device: only credit lines are sent to be matched, and only the
        lines that confirm a payment are kept, on the student&apos;s claim.
      </p>
      <div className="form">
        <label htmlFor="st-file">
          <span>Statement file</span>
          <input id="st-file" type="file" accept=".csv,.txt,.xlsx,text/csv" onChange={(e) => void choose(e.target.files?.[0])} />
        </label>
        <label htmlFor="st-bank">
          <span>Bank</span>
          <select id="st-bank" value={bank} onChange={(e) => setBank(e.target.value)}>
            {desk.banks.map((b: string) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        {file && (
          <>
            <label htmlFor="st-header">
              <span>Header row</span>
              <select id="st-header" value={header} onChange={(e) => setHeader(Number(e.target.value))}>
                {file.grid.slice(0, 15).map((r, i) => (
                  <option key={i} value={i}>
                    Row {i + 1}: {r.filter(Boolean).join(' · ').slice(0, 80)}
                  </option>
                ))}
              </select>
            </label>
            <div className="row">
              {FIELDS.map(([key, label, required]) => (
                <label key={key} htmlFor={`st-${key}`}>
                  <span>{label}</span>
                  <select id={`st-${key}`} value={columns[key] as number} onChange={(e) => setColumns((c) => ({ ...c, [key]: Number(e.target.value) }))}>
                    <option value={-1}>{required ? 'Choose a column' : 'None'}</option>
                    {heads.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={monthFirst} onChange={(e) => setMonthFirst(e.target.checked)} /> Dates are written month first (10/05/2026 is 5
              October)
            </label>
            {preview ? (
              <p>
                {preview.lines.length} credit line{preview.lines.length === 1 ? '' : 's'} found
                {preview.skipped ? `; ${preview.skipped} other row${preview.skipped === 1 ? '' : 's'} (debits, totals, blank) skipped` : ''}.
                {preview.lines[0] &&
                  ` First: ${preview.lines[0].date}, ${formatAmount(preview.lines[0].amount, desk.currency)}, ${preview.lines[0].reference || preview.lines[0].description}.`}
              </p>
            ) : (
              <p className="muted">Choose the date, credit and reference columns.</p>
            )}
            <div className="actions">
              <Button kind="primary" disabled={!preview?.lines.length || !!busy} onClick={run}>
                Match payments
              </Button>
            </div>
          </>
        )}
      </div>
      {busy && <p role="status">{busy}</p>}
      {problem && <p role="alert">{problem}</p>}
      {result && (
        <p role="status">
          {result.lines} line{result.lines === 1 ? '' : 's'} checked: {result.matched} payment{result.matched === 1 ? '' : 's'} confirmed.
          {result.issues
            ? ` ${result.issues} claim${result.issues === 1 ? ' has' : 's have'} the reference on the statement with a different amount or date.`
            : ''}{' '}
          {result.open} claim{result.open === 1 ? '' : 's'} from {bank} still waiting.
        </p>
      )}
    </Panel>
  );
}
