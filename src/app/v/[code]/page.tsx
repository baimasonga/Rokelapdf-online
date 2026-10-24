'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BadgeCheck, CircleAlert, CircleX } from 'lucide-react';
import { PublicFrame } from '@/components/public';
import { Details, Muted, Panel } from '@/components/ui';
import { ApiError, api, enc } from '@/lib/client/api';
import { sha256Hex } from '@/lib/client/sha256';
/* eslint-disable @typescript-eslint/no-explicit-any */

const REASONS: Record<string, string> = {
  issued_in_error: 'issued in error',
  superseded: 'replaced by a newer document',
  payment_reversed: 'payment reversed or not received',
  fraud_suspected: 'fraud suspected',
  other: 'withdrawn by the issuer',
};
const day = (v: string) => new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

type View = { k: 'loading' } | { k: 'missing' } | { k: 'error' } | { k: 'ok'; v: any };
type Check = { k: 'idle' } | { k: 'busy' } | { k: 'match' } | { k: 'mismatch' } | { k: 'unreadable' };

/** Public verification page: shows what the issuer published, and checks a copy on this device without uploading it. */
export default function VerifyPage() {
  const { code } = useParams<{ code: string }>();
  const [view, setView] = useState<View>({ k: 'loading' });
  const [check, setCheck] = useState<Check>({ k: 'idle' });

  useEffect(() => {
    api(`/api/v1/public/verifications/${enc(code)}`).then(
      (v) => setView({ k: 'ok', v }),
      (e: ApiError) => setView({ k: e.status === 404 ? 'missing' : 'error' }),
    );
  }, [code]);

  const compare = async (file: File | undefined) => {
    if (!file || view.k !== 'ok') return;
    setCheck({ k: 'busy' });
    try {
      const digest = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
      setCheck({ k: digest === view.v.sha256 ? 'match' : 'mismatch' });
    } catch {
      setCheck({ k: 'unreadable' });
    }
  };

  if (view.k === 'loading')
    return (
      <PublicFrame>
        <Muted>Checking…</Muted>
      </PublicFrame>
    );
  if (view.k !== 'ok')
    return (
      <PublicFrame>
        <Panel title={view.k === 'missing' ? 'No document with this code' : 'Verification is unavailable'}>
          {view.k === 'missing' ? (
            <p>
              Rokela PDF has no issued document with this code. Check that the code was typed correctly. If it came from a QR code on a document, the document
              may not be genuine: confirm with the organization that supposedly issued it.
            </p>
          ) : (
            <p>Please try again in a moment.</p>
          )}
        </Panel>
      </PublicFrame>
    );

  const v = view.v;
  const valid = v.status === 'active';
  const domains: string[] = v.issuer.verified_domains;
  return (
    <PublicFrame>
      <Panel
        title={
          <span className="verify-status">
            {valid ? <BadgeCheck aria-hidden /> : <CircleX aria-hidden />} {valid ? 'Valid document' : 'Revoked document'}
          </span>
        }
      >
        {!valid && (
          <p role="alert">
            The issuer revoked this document on {day(v.revoked_at)} ({REASONS[v.revocation_reason] ?? 'withdrawn by the issuer'}). Do not rely on it.
          </p>
        )}
        <Details
          items={[
            ['Document', v.title],
            ['Issued by', v.issuer.name],
            ['Issued on', day(v.issued_at)],
            ['Code', v.code],
          ]}
        />
        {v.details.length > 0 && (
          <>
            <h3>Details published by the issuer</h3>
            <Details items={v.details.map((d: { label: string; value: string }): [string, string] => [d.label, d.value])} />
          </>
        )}
        {domains.length ? (
          <p className="muted">
            <BadgeCheck aria-hidden /> The issuer controls {domains.join(', ')} (verified by DNS).
          </p>
        ) : (
          <p className="muted">
            <CircleAlert aria-hidden /> Rokela PDF has not verified this issuer&apos;s identity. The name above was chosen by the issuer; if in doubt, confirm
            with the organization directly.
          </p>
        )}
      </Panel>
      <Panel title="Check your copy">
        <p>Choose the PDF you received to confirm it is exactly the file that was issued. The check runs on this device; the file is not uploaded.</p>
        <label htmlFor="verify-file">
          <span>PDF to check</span>
          <input id="verify-file" type="file" accept="application/pdf,.pdf" onChange={(e) => void compare(e.target.files?.[0])} />
        </label>
        {check.k === 'busy' && <Muted>Checking…</Muted>}
        {check.k === 'match' &&
          (valid ? (
            <p role="status">
              <BadgeCheck aria-hidden /> Exact match: this file is the document that was issued.
            </p>
          ) : (
            // A genuine copy of a revoked document must not look reassuring.
            <p role="alert">
              <CircleAlert aria-hidden /> This file is the document that was issued, but the issuer has revoked it. Do not rely on it.
            </p>
          ))}
        {check.k === 'mismatch' && (
          <p role="alert">
            <CircleX aria-hidden /> This file does not match. It may have been altered, re-saved or exported again, or it is a different document. A printed
            copy cannot be checked this way; rely on the details above instead.
          </p>
        )}
        {check.k === 'unreadable' && <p role="alert">This file could not be read.</p>}
      </Panel>
    </PublicFrame>
  );
}
