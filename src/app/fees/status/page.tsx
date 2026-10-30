'use client';
import { useEffect, useState } from 'react';
import { BadgeCheck, CircleX, Clock, Download } from 'lucide-react';
import { PublicFrame } from '@/components/public';
import { Button, Details, Muted, Panel } from '@/components/ui';
import { ApiError, api, apiBlob } from '@/lib/client/api';
/* eslint-disable @typescript-eslint/no-explicit-any */

// The private status link a student receives after claiming a fee payment (docs/receipt-processing.md). The secret is in
// the URL fragment, which browsers never send to the server; this page sends it in a header.

type View = { k: 'loading' } | { k: 'missing' } | { k: 'error' } | { k: 'ok'; v: any };

const STEPS: Record<string, { title: string; text: string }> = {
  submitted: {
    title: 'Waiting for the bank statement',
    text: 'The finance office has your claim and will confirm the payment when it appears on the bank statement. This usually takes a few working days.',
  },
  matched: { title: 'Payment confirmed', text: 'Your payment was confirmed. Your clearance certificate will be issued soon.' },
};

export default function FeeStatusPage() {
  const [view, setView] = useState<View>({ k: 'loading' });
  const headers = () => ({ 'x-claim-secret': window.location.hash.slice(1) });

  useEffect(() => {
    (window.location.hash.length > 1
      ? api('/api/v1/public/fee-claims/status', { auth: false, headers: headers() })
      : Promise.reject(new ApiError('not found', 404))
    ).then(
      (v) => setView({ k: 'ok', v }),
      (e: ApiError) => setView({ k: e.status === 404 ? 'missing' : 'error' }),
    );
  }, []);

  if (view.k === 'loading')
    return (
      <PublicFrame>
        <Muted>Opening…</Muted>
      </PublicFrame>
    );
  if (view.k !== 'ok')
    return (
      <PublicFrame>
        <Panel title={view.k === 'missing' ? 'Claim not found' : 'Status is unavailable'}>
          {view.k === 'missing' ? (
            <p>Check that you opened the whole link you received after sending your payment details.</p>
          ) : (
            <p>Please try again in a moment.</p>
          )}
        </Panel>
      </PublicFrame>
    );

  const v = view.v;
  const cert = v.certificate;
  const step = STEPS[v.status];
  return (
    <PublicFrame>
      <Panel
        title={
          <span className="verify-status">
            {v.status === 'cleared' && cert?.status === 'active' ? (
              <>
                <BadgeCheck aria-hidden /> Cleared
              </>
            ) : v.status === 'rejected' || cert?.status === 'revoked' ? (
              <>
                <CircleX aria-hidden /> {v.status === 'rejected' ? 'Not cleared' : 'Certificate revoked'}
              </>
            ) : (
              <>
                <Clock aria-hidden /> {step?.title}
              </>
            )}
          </span>
        }
      >
        {step && v.status !== 'cleared' && <p>{step.text}</p>}
        {v.rejection && (
          <div role="alert">
            <p>{v.rejection.text}</p>
            {v.rejection.message && <p>Message from the finance office: {v.rejection.message}</p>}
            <p>If you did pay, contact the finance office with your original bank receipt. You can send a new claim through the same page.</p>
          </div>
        )}
        {cert?.status === 'revoked' && <p role="alert">The finance office revoked your clearance certificate. Contact them for details.</p>}
        {cert && cert.status === 'active' && (
          <>
            <p>Your fee clearance certificate is ready. Print it or show it on your phone: staff scan its QR code to confirm it.</p>
            <div className="actions">
              <Button
                kind="primary"
                onClick={async () => {
                  const blob = await apiBlob('/api/v1/public/fee-claims/certificate', { auth: false, headers: headers() });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `fee-clearance-${v.student_id.replace(/[^A-Za-z0-9_-]+/g, '-')}.pdf`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 30_000);
                }}
              >
                <Download size={16} aria-hidden="true" /> Download certificate
              </Button>
              <a href={cert.url}>Check page</a>
            </div>
          </>
        )}
        <Details
          items={[
            ['Institution', v.institution],
            ['For', v.title],
            ['Student', `${v.student_name} (${v.student_id})`],
            ['Payment', `${v.amount} on ${v.paid_on}`],
            ['Bank', `${v.bank}, reference ${v.reference}`],
            ['Sent', new Date(v.submitted_at).toLocaleString()],
          ]}
        />
        <p className="muted">Keep this link private: anyone who has it can see this claim and download the certificate.</p>
      </Panel>
    </PublicFrame>
  );
}
