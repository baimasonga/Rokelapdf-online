'use client';
import { Badge, Button, Empty, Muted, Panel, Table } from '@/components/ui';
import { api } from '@/lib/client/api';
import { when } from '@/lib/client/format';
import { useLoad, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Notifications() {
  const { P } = useWs();
  const { data, error, reload } = useLoad<any>(() => api(`${P}/notifications`), [P]);
  if (error) return <Panel title="Notifications">{error.message}</Panel>;
  if (!data) return <Muted>Loading…</Muted>;
  const unread = data.items.filter((n: any) => !n.read).map((n: any) => n.id as string);
  return (
    <Panel
      title="Notifications"
      actions={
        unread.length > 0 && (
          <Button
            onClick={async () => {
              await api(`${P}/notifications/read`, { body: { ids: unread.slice(0, 100) } });
              reload();
            }}
          >
            Mark all read
          </Button>
        )
      }
    >
      {data.items.length ? (
        <Table
          head={['When', 'Notification', '']}
          rows={data.items.map((n: any) => [when(n.created_at), n.message, n.read ? '' : <Badge key="n" state="new" />])}
        />
      ) : (
        <Empty>No notifications.</Empty>
      )}
    </Panel>
  );
}
