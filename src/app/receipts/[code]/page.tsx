'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BadgeCheck, CircleAlert, CircleX } from 'lucide-react';
import { PublicFrame } from '@/components/public';
import { Details, Muted, Panel } from '@/components/ui';
import { ApiError, api, enc } from '@/lib/client/api';
import { sha256Hex } from '@/lib/client/sha256';
import { money } from '@/lib/receipts/model';

// Public receipt check (docs/receipt-checks.md): what the business registered when it made the document, whether it
// was cancelled since, and a check that a PDF copy is exactly the file that was made, without uploading it.

interface View {
  code: string;
  kind: 'receipt' | 'invoice' | 'proforma';
  business_name: string;
  number: string;
  issued_on: string;
  currency: string;
  total: number;
  customer_name: string | null;
  sha256: string | null;
  status: 'active' | 'cancelled';
  registered_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

const KIND: Record<View['kind'], string> = { receipt: 'Cash receipt', invoice: 'Invoice', proforma: 'Proforma invoice (quotation)' };
const REASONS: Record<string, string> = {
  issued_in_error: 'made in error',
  replaced: 'replaced by a corrected copy',
  refunded: 'refunded or not paid',
  other: 'withdrawn by the business',
};
const day = (v: string) => new Date(v.length === 10 ? `${v}T12:00:00` : v).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

type State = { k: 'loading' } | { k: 'missing' } | { k: 'error' } | { k: 'ok'; v: View };
type Copy = { k: 'idle' } | { k: 'busy' } | { k: 'match' } | { k: 'mismatch' } | { k: 'unreadable' };

export default function ReceiptCheckPage() {
  const { code } = useParams<{ code: string }>();
  const [state, setState] = useState<State>({ k: 'loading' });
  const [copy, setCopy] = useState<Copy>({ k: 'idle' });

  useEffect(() => {
    api<View>(`/api/v1/public/receipt-checks/${enc(code)}`, { auth: false }).then(
      (v) => setState({ k: 'ok', v }),
      (e: ApiError) => setState({ k: e.status === 404 ? 'missing' : 'error' }),
    );
  }, [code]);

  const compare = async (file: File | undefined) => {
    if (!file || state.k !== 'ok') return;
    setCopy({ k: 'busy' });
    try {
      const digest = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
      setCopy({ k: digest === state.v.sha256 ? 'match' : 'mismatch' });
    } catch {
      setCopy({ k: 'unreadable' });
    }
  };

  if (state.k === 'loading')
    return (
      <PublicFrame>
        <Muted>Checking…</Muted>
      </PublicFrame>
    );
  if (state.k !== 'ok')
    return (
      <PublicFrame>
        <Panel title={state.k === 'missing' ? 'No document with this code' : 'The check is unavailable'}>
          {state.k === 'missing' ? (
            <p>
              Rokela PDF has no receipt, invoice or quotation with this code. Check that it was typed correctly. If it came from a QR code on a document, the
              document may not be genuine: ask the business that supposedly made it.
            </p>
          ) : (
            <p>Please try again in a moment.</p>
          )}
        </Panel>
      </PublicFrame>
    );

  const v = state.v;
  const valid = v.status === 'active';
  return (
    <PublicFrame>
      <Panel
        title={
          <span className="verify-status">
            {valid ? <BadgeCheck aria-hidden /> : <CircleX aria-hidden />} {valid ? `${KIND[v.kind]} on record` : `Cancelled ${KIND[v.kind].toLowerCase()}`}
          </span>
        }
      >
        {!valid && v.cancelled_at && (
          <p role="alert">
            The business cancelled this document on {day(v.cancelled_at)} ({REASONS[v.cancel_reason ?? ''] ?? 'withdrawn by the business'}). Do not rely on it.
          </p>
        )}
        <p>Compare these details with the paper or PDF in front of you. If any of them differ, the document was changed after it was made.</p>
        <Details
          items={[
            ['Business', v.business_name],
            ['Number', v.number],
            ['Date', day(v.issued_on)],
            [v.kind === 'invoice' ? 'Invoice total' : 'Total', `${v.currency} ${money(v.total)}`],
            ...(v.customer_name ? ([[v.kind === 'receipt' ? 'Received from' : 'Customer', v.customer_name]] as Array<[string, string]>) : []),
            ['Code', v.code],
          ]}
        />
        <p className="muted">
          <CircleAlert aria-hidden /> The business typed its own name; Rokela PDF has not checked who runs it. This is not an NRA fiscal receipt.
        </p>
      </Panel>
      {v.sha256 && (
        <Panel title="Check a PDF copy">
          <p>Choose the PDF you were sent to confirm it is exactly the file the business made. The check runs on this device; the file is not uploaded.</p>
          <label htmlFor="check-file">
            <span>PDF to check</span>
            <input id="check-file" type="file" accept="application/pdf,.pdf" onChange={(e) => void compare(e.target.files?.[0])} />
          </label>
          {copy.k === 'busy' && <Muted>Checking…</Muted>}
          {copy.k === 'match' &&
            (valid ? (
              <p role="status">
                <BadgeCheck aria-hidden /> Exact match: this file is the one the business made.
              </p>
            ) : (
              <p role="alert">
                <CircleAlert aria-hidden /> This file is the one the business made, but it has been cancelled. Do not rely on it.
              </p>
            ))}
          {copy.k === 'mismatch' && (
            <p role="alert">
              <CircleX aria-hidden /> This file does not match. It may have been altered or saved again, or it is a different document. A printed copy cannot be
              checked this way; compare the details above instead.
            </p>
          )}
          {copy.k === 'unreadable' && <p role="alert">This file could not be read.</p>}
        </Panel>
      )}
    </PublicFrame>
  );
}
