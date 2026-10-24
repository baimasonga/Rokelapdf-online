'use client';
import { useState, type FormEvent } from 'react';
import { Badge, Button, CopyField, Empty, Form, Modal, Muted, Panel, Table, useNotice } from '@/components/ui';
import { api, enc } from '@/lib/client/api';
import { when } from '@/lib/client/format';
import { sha256Hex } from '@/lib/client/sha256';
import { stampVerification } from '@/lib/tools/ops';
import { useLoad, useWs } from './context';
/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_DETAILS = 8;
const REASONS: Array<[string, string]> = [
  ['issued_in_error', 'Issued in error'],
  ['superseded', 'Replaced by a newer document'],
  ['payment_reversed', 'Payment reversed or not received'],
  ['fraud_suspected', 'Fraud suspected'],
  ['other', 'Other'],
];
const REASON_TEXT = Object.fromEntries(REASONS);

function save(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Issue PDFs with a verification QR code; the PDF is stamped and fingerprinted on this device and never uploaded. */
export function VerifiedDocuments() {
  const { P, workspace, me } = useWs();
  const notice = useNotice();
  const [file, setFile] = useState<File>();
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState<Array<{ label: string; value: string }>>([{ label: '', value: '' }]);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ url: string; name: string; bytes: Uint8Array }>();
  const [revoking, setRevoking] = useState<any>();
  const base = `${P}/verified-documents`;
  const { data, error, reload } = useLoad<any>(() => api(base), [base]);
  const manager = workspace.role === 'owner' || workspace.role === 'admin';

  if (workspace.kind !== 'team')
    return (
      <Panel title="Verified documents">
        <Empty>Verified documents are issued from a team workspace, so the verification page names your organization. Create or switch to a team.</Empty>
      </Panel>
    );

  const issue = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const input = new Uint8Array(await file.arrayBuffer());
      const used = details.filter((d) => d.label.trim() || d.value.trim()).map((d) => ({ label: d.label.trim(), value: d.value.trim() }));
      const reserved = await api(base, { body: { title: title.trim(), details: used } });
      const stamped = await stampVerification(input, reserved.url);
      await api(`${base}/${enc(reserved.id)}/issue`, { body: { sha256: await sha256Hex(stamped) } });
      const name = `${file.name.replace(/\.pdf$/i, '')}-verified.pdf`;
      setIssued({ url: reserved.url, name, bytes: stamped });
      save(name, stamped);
      setFile(undefined);
      setTitle('');
      setDetails([{ label: '', value: '' }]);
      (e.target as HTMLFormElement).reset();
      reload();
    } catch (err) {
      notice((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title="Issue a verified PDF">
        <p>
          Adds a QR code to every page. Anyone who scans it sees that <strong>{workspace.name}</strong> issued this document, the details you publish below, and
          whether it is still valid. Your PDF is stamped on this device and is not uploaded; only its fingerprint is recorded.
        </p>
        <p className="muted">
          Everything you enter here is public to anyone holding the document. Publish only what a checker needs, for example a student or reference number, not
          phone numbers or full payment records.
        </p>
        <form className="form" onSubmit={issue}>
          <label htmlFor="vd-file">
            <span>PDF to issue</span>
            <input id="vd-file" type="file" accept="application/pdf,.pdf" required onChange={(e) => setFile(e.target.files?.[0])} />
          </label>
          <label htmlFor="vd-title">
            <span>Title shown on the verification page</span>
            <input
              id="vd-title"
              required
              maxLength={200}
              value={title}
              placeholder="Fee clearance — 2026/27, first semester"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          {details.map((d, i) => (
            <div key={i} className="row">
              <label htmlFor={`vd-l-${i}`}>
                <span>Detail {i + 1} label</span>
                <input
                  id={`vd-l-${i}`}
                  maxLength={40}
                  value={d.label}
                  placeholder="Student ID"
                  onChange={(e) => setDetails((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))}
                />
              </label>
              <label htmlFor={`vd-v-${i}`}>
                <span>Detail {i + 1} value</span>
                <input
                  id={`vd-v-${i}`}
                  maxLength={200}
                  value={d.value}
                  placeholder="FBC/2024/123"
                  onChange={(e) => setDetails((x) => x.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))}
                />
              </label>
            </div>
          ))}
          <div className="actions">
            {details.length < MAX_DETAILS && (
              <button type="button" onClick={() => setDetails((x) => [...x, { label: '', value: '' }])}>
                Add detail
              </button>
            )}
            <button type="submit" className="primary" disabled={busy || !file}>
              {busy ? 'Working…' : 'Issue and download'}
            </button>
          </div>
        </form>
        {issued && (
          <>
            <h3>Issued</h3>
            <p>Share or print this downloaded file. Re-saving or editing it will make “Check your copy” fail; the QR status check still works on paper.</p>
            <CopyField label="Verification page" value={issued.url} />
            <Button onClick={() => save(issued.name, issued.bytes)}>Download again</Button>
          </>
        )}
      </Panel>
      <Panel title="Issued documents">
        {error ? (
          <p role="alert">{error.message}</p>
        ) : !data ? (
          <Muted>Loading…</Muted>
        ) : !data.items.length ? (
          <Empty>No verified documents yet.</Empty>
        ) : (
          <Table
            head={['Document', 'Issued', 'Status', '']}
            rows={data.items.map((v: any) => [
              v.title,
              when(v.issued_at),
              v.status === 'revoked' ? `Revoked — ${REASON_TEXT[v.revocation_reason] ?? v.revocation_reason}` : <Badge key="s" state="active" />,
              <span key="a" className="actions">
                <a href={v.url} target="_blank" rel="noreferrer">
                  Verification page
                </a>
                {v.status === 'active' && (manager || v.created_by === me.id) && <Button onClick={() => setRevoking(v)}>Revoke</Button>}
              </span>,
            ])}
          />
        )}
      </Panel>
      <Modal open={!!revoking} onClose={() => setRevoking(undefined)} title="Revoke verified document">
        {revoking && (
          <>
            <p>
              Revoking <strong>{revoking.title}</strong> is permanent. Its verification page will show it as revoked with the reason you choose.
            </p>
            <Form
              fields={[{ name: 'reason', label: 'Reason shown publicly', type: 'select', options: REASONS }]}
              submit="Revoke permanently"
              kind="danger"
              onSubmit={async (f) => {
                await api(`${base}/${enc(revoking.id)}/revoke`, { body: { reason: f.reason } });
                setRevoking(undefined);
                reload();
              }}
            />
          </>
        )}
      </Modal>
    </>
  );
}
