'use client';
import { Button, Empty, Form, Muted, Panel, Table, confirmAction, useNotice } from '@/components/ui';
import { api, enc } from '@/lib/client/api';
import { when } from '@/lib/client/format';
import { useLoad, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Members() {
  const { workspace } = useWs();
  const notice = useNotice();
  const base = `/api/v1/workspaces/${enc(workspace.id)}`;
  const path = `${base}/members`;
  const canManage = workspace.role !== 'member';
  const { data, error } = useLoad<any>(() => api(path), [path]);
  const invites = useLoad<any>(() => (canManage ? api(`${base}/invitations`) : Promise.resolve({ items: [] })), [base, canManage]);
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
        <>
          <Panel title="Pending invitations">
            {invites.error ? (
              <p>{invites.error.message}</p>
            ) : !invites.data ? (
              <Muted>Loading…</Muted>
            ) : invites.data.items.length ? (
              <Table
                head={['Email', 'Role', 'Expires', '']}
                rows={invites.data.items.map((i: any) => [
                  i.email,
                  i.role,
                  when(i.expires_at),
                  <Button
                    key={i.id}
                    kind="ghost"
                    onClick={async () => {
                      if (!confirmAction(`Cancel the invitation to ${i.email}?`)) return;
                      await api(`${base}/invitations/${enc(i.id)}/cancel`, { body: {} });
                      invites.reload();
                    }}
                  >
                    Cancel
                  </Button>,
                ])}
              />
            ) : (
              <Muted>No pending invitations.</Muted>
            )}
          </Panel>
          <Panel title="Invite a member">
            <p className="muted">
              They join only after accepting, signed in with this email address confirmed. We email them the invitation; it also appears when they sign in.
              Invitations expire after 7 days.
            </p>
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
              submit="Send invitation"
              onSubmit={async (v) => {
                await api(path, { body: { email: v.email, role: v.role } });
                notice(`Invitation sent to ${v.email}.`);
                invites.reload();
              }}
            />
          </Panel>
        </>
      )}
    </>
  );
}
