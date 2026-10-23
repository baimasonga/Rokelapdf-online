'use client';
import { Button, Panel, Table, useNotice } from '@/components/ui';
import { api, enc } from '@/lib/client/api';
import { when } from '@/lib/client/format';

export interface ReceivedInvitation {
  id: string;
  role: string;
  workspace_name: string;
  invited_by: string;
  expires_at: string;
}

/** Team invitations waiting for the signed-in user. Nothing changes until they accept. */
export function ReceivedInvitations({ items, onAnswered }: { items: ReceivedInvitation[]; onAnswered: (workspaceId?: string) => unknown }) {
  const notice = useNotice();
  if (!items.length) return null;
  const answer = async (i: ReceivedInvitation, accept: boolean) => {
    const r = await api<{ workspace?: { id: string } }>(`/api/v1/invitations/${enc(i.id)}/${accept ? 'accept' : 'decline'}`, { body: {} });
    notice(accept ? `You joined ${i.workspace_name}.` : 'Invitation declined.');
    await onAnswered(r.workspace?.id);
  };
  return (
    <Panel title={items.length === 1 ? 'You have a team invitation' : 'You have team invitations'}>
      <Table
        head={['Workspace', 'Invited by', 'Role', 'Expires', '']}
        rows={items.map((i) => [
          i.workspace_name,
          i.invited_by,
          i.role,
          when(i.expires_at),
          <div className="actions" key={i.id} style={{ margin: 0 }}>
            <Button kind="primary" onClick={() => answer(i, true)}>
              Accept
            </Button>
            <Button kind="ghost" onClick={() => answer(i, false)}>
              Decline
            </Button>
          </div>,
        ])}
      />
    </Panel>
  );
}
