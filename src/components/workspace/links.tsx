'use client';
import { Badge, Button, CopyField, Details, Empty, Form, Muted, Panel, Table, ask } from '@/components/ui';
import { api, enc } from '@/lib/client/api';
import { inDays, splitList, when } from '@/lib/client/format';
import { useLoad, useWs, type LinkTarget } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
const serves = (l: any) =>
  l.target_type === 'document'
    ? l.version_mode === 'fixed'
      ? `Fixed version ${l.serves_version}`
      : `Latest published${l.serves_version ? ` (v${l.serves_version})` : ' — none published yet'}`
    : 'Transfer files';

export function ShareLinks() {
  const { nav } = useWs();
  return nav.id ? <LinkDetail id={nav.id} /> : <LinkList />;
}

function LinkList() {
  const { P, go, nav } = useWs();
  const { data, error } = useLoad<any>(() => api(`${P}/links`), [P]);
  return (
    <>
      {nav.linkTarget && <LinkForm target={nav.linkTarget} />}
      <Panel title="Share links">
        {error ? (
          <p>{error.message}</p>
        ) : !data ? (
          <Muted>Loading…</Muted>
        ) : data.items.length ? (
          <Table
            head={['Link', 'Target', 'Serves', 'Access', 'State', '']}
            rows={data.items.map((l: any) => [
              l.label || l.id,
              l.target_type,
              serves(l),
              `${l.permission}${l.has_password ? ' · password' : ''}${l.restriction !== 'none' ? ` · ${l.restriction}` : ''}`,
              <Badge key="s" state={l.state} />,
              <Button key="m" onClick={() => go('links', l.id)}>
                Manage
              </Button>,
            ])}
          />
        ) : (
          <Empty>No share links yet. Create one from a document or a transfer.</Empty>
        )}
      </Panel>
    </>
  );
}

function LinkForm({ target }: { target: LinkTarget }) {
  const { P, go } = useWs();
  return (
    <Panel title={`Share ${target.label ?? ''}`}>
      {target.version_mode && (
        <p className="muted">
          {target.version_mode === 'fixed'
            ? 'This link will always serve this exact version.'
            : 'This link follows the version you publish. Unpublished edits never appear.'}
        </p>
      )}
      <Form
        fields={[
          {
            name: 'permission',
            label: 'Access',
            type: 'select',
            options: [
              ['download', 'View and download'],
              ['view', 'View only (cannot stop screenshots or copying)'],
              ...(target.target_type === 'document' ? ([['review', 'Review: comment and approve (signed-in recipients)']] as Array<[string, string]>) : []),
            ],
          },
          {
            name: 'restriction',
            label: 'Who can open it',
            type: 'select',
            options: [
              ['none', 'Anyone with the link'],
              ['members', 'Members of this workspace'],
              ['recipients', 'Named recipients (verified accounts)'],
            ],
          },
          { name: 'recipients', label: 'Recipient emails, comma separated', show: (v) => v.restriction === 'recipients' },
          { name: 'password', label: 'Password (8+ characters)', type: 'password', optional: true, autoComplete: 'new-password' },
          { name: 'days', label: 'Expires after days', type: 'number', optional: true, min: 1 },
          { name: 'max_downloads', label: 'Download limit', type: 'number', optional: true, min: 1 },
          { name: 'notify', label: 'Notify me on access, download and acknowledgement', type: 'checkbox' },
        ]}
        submit="Create share link"
        onSubmit={async (f) => {
          const l = await api(`${P}/links`, {
            body: {
              target_type: target.target_type,
              target_id: target.target_id,
              ...(target.version_mode ? { version_mode: target.version_mode } : {}),
              ...(target.version_id ? { version_id: target.version_id } : {}),
              permission: f.permission,
              restriction: f.restriction,
              ...(f.restriction === 'recipients' ? { recipients: splitList(f.recipients) } : {}),
              ...(f.password ? { password: f.password } : {}),
              ...(f.days ? { expires_at: inDays(f.days) } : {}),
              ...(f.max_downloads ? { max_downloads: Number(f.max_downloads) } : {}),
              notify_on_access: f.notify === 'yes',
              ...(target.label ? { label: target.label.slice(0, 200) } : {}),
            },
          });
          go('links', l.id);
        }}
      />
    </Panel>
  );
}

function LinkDetail({ id }: { id: string }) {
  const { P, go } = useWs();
  const { data, error, reload } = useLoad(async () => {
    const [l, act] = await Promise.all([api(`${P}/links/${enc(id)}`), api(`${P}/links/${enc(id)}/activity`)]);
    return { l, act };
  }, [P, id]);
  if (error) return <Panel title="Share link">{error.message}</Panel>;
  if (!data) return <Muted>Loading…</Muted>;
  const { l, act } = data;
  const status = (action: string) => async () => {
    const reason = action === 'revoke' ? ask('Reason (optional):') : undefined;
    await api(`${P}/links/${enc(id)}/status`, { body: { action, ...(reason ? { reason } : {}) } });
    reload();
  };
  const totals = Object.entries(act.totals as Record<string, { count: number; bots: number }>);
  return (
    <>
      <Panel
        title={l.label || 'Share link'}
        actions={
          <Button kind="ghost" onClick={() => go('links')}>
            ← All share links
          </Button>
        }
      >
        <CopyField value={l.url} label="Share link URL" />
        <Details
          items={[
            ['State', <Badge key="s" state={l.state} />],
            ['Serves', serves(l)],
            ['Permission', l.permission],
            [
              'Access',
              l.restriction === 'recipients'
                ? `Recipients: ${l.recipients.join(', ')}`
                : l.restriction === 'members'
                  ? 'Workspace members'
                  : 'Anyone with the link',
            ],
            ['Password', l.has_password ? 'Yes' : 'No'],
            ['Expires', when(l.expires_at)],
            ['Downloads', l.max_downloads ? `${l.download_count} of ${l.max_downloads}` : String(l.download_count)],
          ]}
        />
        <div className="actions">
          {l.status === 'active' && <Button onClick={status('suspend')}>Suspend</Button>}
          {l.status === 'suspended' && <Button onClick={status('resume')}>Resume</Button>}
          {(l.status === 'active' || l.status === 'suspended') && (
            <Button kind="danger" onClick={status('revoke')}>
              Revoke
            </Button>
          )}
        </div>
      </Panel>
      <Panel title="Short link and QR code">
        <p className="muted">Confidential short links use an unpredictable code. The share link’s password, expiry and recipients still apply.</p>
        <Button
          onClick={async () => {
            const s = await api(`${P}/short-links`, {
              body: { kind: 'confidential', destination_type: 'share', target_id: id, ...(l.label ? { label: l.label } : {}) },
            });
            go('short-links', s.id);
          }}
        >
          Create confidential short link
        </Button>
      </Panel>
      <Panel title="Delivery receipts">
        {act.notes.map((n: string) => (
          <p key={n} className="muted">
            {n}
          </p>
        ))}
        {totals.length ? (
          <Table head={['Event', 'Count', 'Likely automated']} rows={totals.map(([k, v]) => [k, v.count, v.bots])} />
        ) : (
          <Empty>No activity yet.</Empty>
        )}
        {act.events.length > 0 && (
          <Table
            head={['When', 'Event', 'Who', 'Automated?']}
            rows={act.events.map((e: any) => [
              when(e.at),
              e.kind,
              e.identity ? (e.identity.email ? `${e.identity.email} (signed in)` : `${e.identity.name} (unverified name)`) : 'Anonymous',
              e.likely_automated ? 'likely' : 'no',
            ])}
          />
        )}
      </Panel>
    </>
  );
}
