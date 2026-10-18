'use client';
import { useState } from 'react';
import { Badge, Empty, Form, Muted, Panel } from '@/components/ui';
import { api } from '@/lib/client/api';
import { when } from '@/lib/client/format';
import { useLoad } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function AbuseReview() {
  const [status, setStatus] = useState('open');
  const { data, error, reload } = useLoad<any>(() => api(`/api/v1/admin/sharing/abuse-reports?status=${status}`), [status]);
  return (
    <Panel title="Abuse reports">
      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="actioned">Actioned</option>
          <option value="dismissed">Dismissed</option>
        </select>
      </label>
      {error ? (
        <p role="alert">{error.message}</p>
      ) : !data ? (
        <Muted>Loading reports…</Muted>
      ) : !data.items.length ? (
        <Empty>No reports.</Empty>
      ) : (
        data.items.map((r: any) => (
          <section className="panel" key={r.id}>
            <h3>
              {r.category} <Badge state={r.status} />
            </h3>
            <p>{r.reference}</p>
            <p>{r.details}</p>
            <p className="muted">
              Reported {when(r.created_at)} · {r.reporter_email ?? 'Anonymous'}
            </p>
            {r.status === 'open' && (
              <Form
                fields={[
                  {
                    name: 'action',
                    label: 'Decision',
                    type: 'select',
                    options: [['dismiss', 'Dismiss report'], ...(r.subject_id ? [['suspend', 'Suspend reported link'] as [string, string]] : [])],
                  },
                  { name: 'reason', label: 'Reason', hint: 'At least 3 characters. This decision is recorded in the audit log.' },
                ]}
                submit="Record decision"
                onSubmit={async (f) => {
                  await api(`/api/v1/admin/sharing/abuse-reports/${r.id}/resolve`, { body: f });
                  reload();
                }}
              />
            )}
            {r.resolution && <p>Resolution: {r.resolution}</p>}
          </section>
        ))
      )}
    </Panel>
  );
}
