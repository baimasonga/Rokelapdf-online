'use client';
import { Button, Panel, Muted } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useLoad } from './context';
interface Status {
  enabled: boolean;
  pending?: number;
  claimed?: number;
  failed?: number;
  dropped?: number;
  oldest_pending_at?: string | null;
  last_ack_at?: string | null;
  last_failure?: string | null;
}
export function MonitoringStatus() {
  const { data, error, reload } = useLoad<Status>(() => api('/api/v1/admin/monitoring'), []);
  return (
    <Panel title="Warrior monitoring delivery">
      <Button onClick={reload}>Refresh status</Button>
      {error ? (
        <p role="alert">{error.message}</p>
      ) : !data ? (
        <Muted>Loading monitoring status…</Muted>
      ) : !data.enabled ? (
        <p>Monitoring is not connected. Configure the scoped server credential and registered components before enabling delivery.</p>
      ) : (
        <>
          <p>
            Queued: {data.pending} · In flight: {data.claimed} · Failed: {data.failed} · Dropped at capacity: {data.dropped}
          </p>
          <p>Last collector acknowledgement: {data.last_ack_at ? new Date(data.last_ack_at).toLocaleString() : 'Not yet acknowledged'}</p>
          <p>Oldest queued observation: {data.oldest_pending_at ? new Date(data.oldest_pending_at).toLocaleString() : 'None'}</p>
          <p>Last failure: {data.last_failure ?? 'None recorded'}</p>
          <Muted>This reports event delivery. It does not establish healthy conversion, scanning or independent monitoring.</Muted>
        </>
      )}
    </Panel>
  );
}
