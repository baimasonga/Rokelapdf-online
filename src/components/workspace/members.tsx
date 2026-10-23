'use client';
import { Button, Empty, Form, Muted, Panel, Table, confirmAction, useNotice } from '@/components/ui';
import { useRouter } from 'next/navigation';
import { api, enc } from '@/lib/client/api';
import { when } from '@/lib/client/format';
import { useLoad, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Members() {
  const { workspace, me, refresh } = useWs();
  const router = useRouter();
  const notice = useNotice();
  const base = `/api/v1/workspaces/${enc(workspace.id)}`;
  const path = `${base}/members`;
  const canManage = workspace.role !== 'member';
  const { data, error, reload } = useLoad<any>(() => api(path), [path]);
  const rank = { member: 1, admin: 2, owner: 3 } as const;
  const mine = workspace.role;
  // Same rule as the server: members ranked at or below you, and owners only by an owner.
  const canEdit = (role: keyof typeof rank) => canManage && rank[role] <= rank[mine] && (role !== 'owner' || mine === 'owner');
  const roles = (['member', 'admin', 'owner'] as const).filter((r) => rank[r] <= rank[mine] && (r !== 'owner' || mine === 'owner'));
  // Your own role or membership changed: reload everything, since the workspace list and your rights change too.
  const changedSelf = async () => {
    await refresh();
    reload();
  };
  const invites = useLoad<any>(() => (canManage ? api(`${base}/invitations`) : Promise.resolve({ items: [] })), [base, canManage]);
  return (
    <>
      <Panel title={`${workspace.name} · members`}>
        {error ? (
          <p>{error.message}</p>
        ) : !data ? (
          <Muted>Loading…</Muted>
        ) : data.items.length ? (
          <Table
            head={['Email', 'Role', '']}
            rows={data.items.map((m: any) => {
              const self = m.user_id === me.id;
              // A team keeps at least one owner; the server refuses this anyway, so do not offer it.
              const lastOwner = m.role === 'owner' && data.items.filter((x: any) => x.role === 'owner').length === 1;
              return [
                self ? `${m.email} (you)` : m.email,
                canEdit(m.role) && !lastOwner ? (
                  <select
                    key={`${m.user_id}:${m.role}`}
                    aria-label={`Role of ${m.email}`}
                    defaultValue={m.role}
                    onChange={async (e) => {
                      const role = e.target.value;
                      if (
                        self &&
                        rank[role as keyof typeof rank] < rank[mine] &&
                        !confirmAction(`Change your own role to ${role}? You may lose access to settings.`)
                      ) {
                        e.target.value = m.role;
                        return;
                      }
                      try {
                        await api(`${path}/${enc(m.user_id)}`, { method: 'PATCH', body: { role } });
                        notice(`${m.email} is now ${role}.`);
                        if (self) await changedSelf();
                        else reload();
                      } catch (err) {
                        e.target.value = m.role;
                        notice((err as Error).message, true);
                      }
                    }}
                  >
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  m.role
                ),
                lastOwner ? (
                  ''
                ) : self ? (
                  <Button
                    key="leave"
                    kind="ghost"
                    onClick={async () => {
                      if (!confirmAction(`Leave ${workspace.name}? You lose access to its files and links.`)) return;
                      await api(`${path}/${enc(m.user_id)}/remove`, { body: {} });
                      await refresh();
                      router.push('/app');
                    }}
                  >
                    Leave team
                  </Button>
                ) : canEdit(m.role) ? (
                  <Button
                    key="remove"
                    kind="danger"
                    onClick={async () => {
                      if (!confirmAction(`Remove ${m.email} from ${workspace.name}? Files and links they created stay in the workspace.`)) return;
                      await api(`${path}/${enc(m.user_id)}/remove`, { body: {} });
                      notice(`${m.email} was removed.`);
                      reload();
                    }}
                  >
                    Remove
                  </Button>
                ) : (
                  ''
                ),
              ];
            })}
          />
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
