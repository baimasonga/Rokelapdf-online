'use client';
import { Details, Muted, Panel } from '@/components/ui';
import { api } from '@/lib/client/api';
import { fmtBytes } from '@/lib/client/format';
import { useLoad, useWs } from './context';

function Meter({ label, used, limit, fmt = fmtBytes }: { label: string; used: number; limit: number; fmt?: (n: number) => string }) {
  return (
    <div className="meter-row">
      <span>{label}</span>
      <meter min={0} max={limit} value={Math.min(used, limit)} />
      <span className="muted">
        {fmt(used)} of {fmt(limit)}
      </span>
    </div>
  );
}

export function Overview() {
  const { P, workspace } = useWs();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: o, error } = useLoad<any>(() => api(`${P}/overview`), [P]);
  if (error) return <Panel title="Overview">{error.message}</Panel>;
  if (!o) return <Muted>Loading…</Muted>;
  const yes = (b: boolean) => (b ? 'Included' : 'Not in plan');
  return (
    <>
      <Panel title={`${workspace.kind === 'personal' ? 'Personal workspace' : workspace.name} · usage ${o.period} (UTC)`}>
        <Meter label="Storage" used={o.usage.storage_bytes} limit={o.limits.storage_bytes} />
        <Meter label="Bandwidth this month" used={o.usage.bandwidth_bytes} limit={o.limits.bandwidth_bytes_per_month} />
        <Meter label="Processing this month" used={o.usage.processing_bytes} limit={o.limits.processing_bytes_per_month} />
        <Meter label="API changes this month" used={o.usage.api_requests} limit={o.limits.api_requests_per_month} fmt={String} />
        <Muted>Bandwidth counts the size of each file delivered through a download link; it is an estimate of transfer volume.</Muted>
      </Panel>
      <Panel title="Plan features">
        <Details
          items={[
            ['Largest file', fmtBytes(o.limits.max_file_bytes)],
            ['Temporary retention', `up to ${o.limits.max_retention_days} days`],
            ['Persistent sharing', yes(o.limits.persistent)],
            ['Upload requests', yes(o.limits.upload_requests)],
            ['Branded pages', yes(o.limits.branding)],
            ['Custom domains', yes(o.limits.custom_domains)],
            ['Advanced analytics', yes(o.limits.advanced_analytics)],
          ]}
        />
      </Panel>
      <Panel title="What sharing controls can and cannot do">
        <p>View-only access cannot prevent screenshots, photos of the screen or other copying.</p>
        <p>Revoking a link stops future access through it. It cannot remove copies that were already downloaded.</p>
        <p>A short URL is not access control. Confidential links use unpredictable codes; passwords, expiry and recipient restrictions protect the content.</p>
      </Panel>
    </>
  );
}
