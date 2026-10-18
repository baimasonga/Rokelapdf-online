'use client';
import { useState } from 'react';
import { Button, Empty, Muted, Panel, Table } from '@/components/ui';
import { api } from '@/lib/client/api';
import { downloadCsv } from '@/lib/client/csv';
import { when } from '@/lib/client/format';
import { useLoad, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function WorkspaceActivity() {
  const { workspace } = useWs();
  const [action, setAction] = useState('');
  const [cursor, setCursor] = useState('');
  const query = new URLSearchParams({ ...(action ? { action } : {}), ...(cursor ? { before: cursor } : {}) });
  const path = `/api/v1/workspaces/${workspace.id}/audit?${query}`;
  const { data, error } = useLoad<any>(() => api(path), [path]);
  return (
    <Panel
      title="Audit log"
      actions={
        <Button
          onClick={async () => {
            const result = await api<any>(`/api/v1/workspaces/${workspace.id}/export`);
            const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'workspace-metadata.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Export workspace metadata
        </Button>
      }
    >
      <p>Owners and admins can review changes to this workspace. The metadata export excludes passwords, access tokens and stored file contents.</p>
      <label>
        Filter action
        <input
          value={action}
          placeholder="For example short_link.created"
          onChange={(e) => {
            setAction(e.target.value);
            setCursor('');
          }}
        />
      </label>
      {error ? (
        <p role="alert">{error.message}</p>
      ) : !data ? (
        <Muted>Loading activity…</Muted>
      ) : (
        <>
          {data.items.length ? (
            <Table
              head={['When', 'Action', 'Actor', 'Target', 'Reason']}
              rows={data.items.map((r: any) => [
                when(r.occurred_at),
                r.action,
                r.actor_id ?? r.actor_type,
                [r.target_type, r.target_id].filter(Boolean).join(': '),
                r.reason ?? '—',
              ])}
            />
          ) : (
            <Empty>No matching events.</Empty>
          )}
          <div className="actions">
            <Button disabled={!cursor} onClick={() => setCursor('')}>
              Newest
            </Button>
            <Button disabled={!data.next_cursor} onClick={() => setCursor(data.next_cursor)}>
              Older events
            </Button>
            <Button
              disabled={!data.items.length}
              onClick={() =>
                downloadCsv('audit-log.csv', [
                  ['When', 'Action', 'Actor type', 'Actor', 'Target type', 'Target', 'Reason'],
                  ...data.items.map((r: any) => [r.occurred_at, r.action, r.actor_type, r.actor_id, r.target_type, r.target_id, r.reason]),
                ])
              }
            >
              Export this page as CSV
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}
