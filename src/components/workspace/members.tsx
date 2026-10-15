'use client';
import { Empty, Form, Muted, Panel, Table } from '@/components/ui';
import { api, enc } from '@/lib/client/api';
import { useLoad, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Members() {
  const { workspace } = useWs();
  const path = `/api/v1/workspaces/${enc(workspace.id)}/members`;
  const { data, error, reload } = useLoad<any>(() => api(path), [path]);
  const canManage = workspace.role !== 'member';
  return (
    <>
      <Panel title={`${workspace.name} · members`}>
        {error ? (
          <p>{error.message}</p>
        ) : !data ? (
          <Muted>Loading…</Muted>
        ) : data.items.length ? (
          <Table head={['Email', 'Role']} rows={data.items.map((m: any) => [m.email, m.role])} />
        ) : (
          <Empty>No members.</Empty>
        )}
      </Panel>
      {canManage && (
        <Panel title="Add a member">
          <p className="muted">The person must have signed in to Rokela PDF Pro at least once.</p>
          <Form
            fields={[
              { name: 'email', label: 'Email', type: 'email' },
              {
                name: 'role',
                label: 'Role',
                type: 'select',
                options: [
                  ['member', 'Member — view, create and share'],
                  ['admin', 'Admin — also manage members and all links'],
                  ...(workspace.role === 'owner' ? ([['owner', 'Owner']] as Array<[string, string]>) : []),
                ],
              },
            ]}
            submit="Add member"
            onSubmit={async (v) => {
              await api(path, { body: { email: v.email, role: v.role } });
              reload();
            }}
          />
        </Panel>
      )}
    </>
  );
}
