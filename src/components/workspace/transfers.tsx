'use client';
import { useEffect, useState } from 'react';
import { Badge, Button, Details, Empty, Muted, Panel, Progress, Table, ask, confirmAction, useNotice } from '@/components/ui';
import { api, enc } from '@/lib/client/api';
import { fmtBytes, inDays, when } from '@/lib/client/format';
import type { UploadProgress } from '@/lib/client/uploader';
import { ownerDownload, ownerUpload, useLoad, usePollWhile, useWs } from './context';
import { SendPanel } from './send';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Transfers() {
  const { nav } = useWs();
  return nav.id ? <TransferDetail id={nav.id} /> : <TransferList />;
}

function TransferList() {
  const { P, go } = useWs();
  const { data, error, reload } = useLoad<any>(() => api(`${P}/transfers`), [P]);
  const items = (data?.items ?? []).slice().sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
  return (
    <div className="send-layout">
      <SendPanel onSent={reload} />
      <Panel title="Sent">
        {error ? (
          <p>{error.message}</p>
        ) : !data ? (
          <Muted>Loading…</Muted>
        ) : items.length ? (
          <ul className="sent-list">
            {items.map((t: any) => (
              <li key={t.id}>
                <button type="button" onClick={() => go('transfers', t.id)}>
                  <span className="sent-title">{t.title}</span>
                  <span className="muted">
                    {t.file_count} file{t.file_count === 1 ? '' : 's'} · {fmtBytes(t.total_bytes)} · {t.downloads} download{t.downloads === 1 ? '' : 's'}
                  </span>
                  <span className="sent-meta">
                    <Badge state={t.status} />
                    <span className="muted">{t.status === 'active' ? expiresIn(t.expires_at) : when(t.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing sent yet. Add files to start a transfer.</Empty>
        )}
      </Panel>
    </div>
  );
}

const expiresIn = (at: string | null) => {
  if (!at) return 'never expires';
  const ms = new Date(at).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const d = Math.round(ms / 86_400_000);
  const h = Math.floor(ms / 3_600_000);
  return d >= 1 ? `expires in ${d} day${d === 1 ? '' : 's'}` : `expires in ${Math.max(1, h)} hour${h === 1 ? '' : 's'}`;
};

/** Recipients of a transfer = its share links (one per person when sent by email), with downloads and actions. */
function Recipients({ transfer }: { transfer: any }) {
  const { P, go, me } = useWs();
  const notice = useNotice();
  const [cfg, setCfg] = useState<{ email: boolean }>();
  const [to, setTo] = useState('');
  const { data, reload } = useLoad<any>(() => api(`${P}/links?target_id=${enc(transfer.id)}`), [P, transfer.id]);
  useEffect(() => {
    api('/api/v1/config', { auth: false }).then(
      (c) => setCfg({ email: !!c.email }),
      () => setCfg({ email: false }),
    );
  }, []);
  const canEmail = !!cfg?.email && me.email_verified;
  const urlOf = async (id: string) => (await api(`${P}/links/${enc(id)}`)).url as string;
  const copy = async (id: string) => {
    const url = await urlOf(id);
    try {
      await navigator.clipboard.writeText(url);
      notice('Link copied.');
    } catch {
      window.prompt('Copy the link:', url);
    }
  };
  const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const forward = async () => {
    const addr = to.trim().toLowerCase();
    if (!isEmail(addr)) return notice('Enter an email address.', true);
    const l = await api(`${P}/links`, {
      body: { target_type: 'transfer', target_id: transfer.id, permission: 'download', notify_on_access: true, label: addr },
    });
    if (canEmail) {
      await api(`${P}/links/${enc(l.id)}/email`, { body: { to: [addr], ...(transfer.message ? { message: transfer.message } : {}) } });
      notice(`Sent to ${addr}.`);
    } else {
      try {
        await navigator.clipboard.writeText(l.url);
        notice(`Personal link for ${addr} copied. Email delivery is not switched on yet, so send it yourself.`);
      } catch {
        window.prompt(`Personal link for ${addr}:`, l.url);
      }
    }
    setTo('');
    reload();
  };
  const links: any[] = data?.items ?? [];
  return (
    <Panel title="Recipients and downloads">
      {links.length ? (
        <Table
          head={['Recipient / link', 'Downloads', 'State', '']}
          rows={links.map((l) => [
            <span key="l">
              {l.label ?? 'Link'}
              {l.has_password ? ' · password' : ''}
            </span>,
            `${l.download_count}${l.max_downloads ? ` of ${l.max_downloads}` : ''}`,
            <Badge key="s" state={l.state} />,
            <div key="a" className="actions">
              <Button onClick={() => copy(l.id)}>Copy link</Button>
              {canEmail && l.state === 'active' && isEmail(l.label ?? '') && (
                <Button
                  onClick={async () => {
                    await api(`${P}/links/${enc(l.id)}/email`, { body: { to: [l.label], ...(transfer.message ? { message: transfer.message } : {}) } });
                    notice(`Email sent again to ${l.label}.`);
                  }}
                >
                  Resend
                </Button>
              )}
              <Button kind="ghost" onClick={() => go('links', l.id)}>
                Activity
              </Button>
              {l.status === 'active' && (
                <Button
                  kind="ghost"
                  onClick={async () => {
                    if (!confirmAction(`Stop the link for ${l.label ?? 'this link'}? Other recipients keep access.`)) return;
                    await api(`${P}/links/${enc(l.id)}/status`, { body: { action: 'revoke' } });
                    reload();
                  }}
                >
                  Revoke
                </Button>
              )}
            </div>,
          ])}
        />
      ) : (
        <Empty>No links yet.</Empty>
      )}
      {transfer.status === 'active' && (
        <div className="forward">
          <input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@example.com"
            aria-label="Forward to"
            onKeyDown={(e) => e.key === 'Enter' && void forward()}
          />
          <Button kind="primary" onClick={forward}>
            {canEmail ? 'Forward' : 'Add recipient'}
          </Button>
          <Button
            onClick={async () => {
              const l = await api(`${P}/links`, {
                body: { target_type: 'transfer', target_id: transfer.id, permission: 'download', notify_on_access: true, label: 'Link' },
              });
              reload();
              try {
                await navigator.clipboard.writeText(l.url);
                notice('New link copied.');
              } catch {
                window.prompt('Copy the link:', l.url);
              }
            }}
          >
            New link
          </Button>
        </div>
      )}
    </Panel>
  );
}

interface Pending {
  name: string;
  p?: UploadProgress;
  done?: string;
}

function TransferDetail({ id }: { id: string }) {
  const { P, go, workspace } = useWs();
  const notice = useNotice();
  const [pending, setPending] = useState<Pending[]>([]);
  const { data: t, error, reload } = useLoad<any>(() => api(`${P}/transfers/${enc(id)}`), [P, id]);
  usePollWhile(!!t?.files.some((f: any) => f.status === 'processing'), reload);
  if (error) return <Panel title="Transfer">{error.message}</Panel>;
  if (!t) return <Muted>Loading…</Muted>;

  const run = async (files: FileList | null) => {
    const list = [...(files ?? [])];
    setPending(list.map((f) => ({ name: f.webkitRelativePath || f.name })));
    for (const [i, file] of list.entries()) {
      const set = (x: Partial<Pending>) => setPending((ps) => ps.map((p, j) => (j === i ? { ...p, ...x } : p)));
      const path = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1).join('/') : undefined;
      try {
        await ownerUpload(workspace.id, file, { target: 'transfer', transfer_id: id, ...(path ? { folder_path: path } : {}) }, (p) => set({ p }));
        set({ done: 'Uploaded · checking' });
      } catch (e) {
        set({ done: (e as Error).message });
      }
    }
    reload();
  };

  const replace = async (f: any, file: File | undefined) => {
    if (!file) return;
    const note = ask('Explain the replacement to recipients (optional):');
    setPending([{ name: `${f.name} (replacement)` }]);
    try {
      await ownerUpload(
        workspace.id,
        file,
        { target: 'replace', transfer_id: id, file_id: f.id, ...(note ? { note } : {}) },
        (p) => setPending([{ name: f.name, p }]),
        f.name,
      );
      setPending([]);
      notice('Replacement uploaded. The link keeps serving the current file until the new one passes checks.');
      reload();
    } catch (e) {
      notice((e as Error).message, true);
    }
  };

  return (
    <>
      <Panel
        title={t.title}
        actions={
          <Button kind="ghost" onClick={() => go('transfers')}>
            ← All transfers
          </Button>
        }
      >
        <Details
          items={[
            ['Kind', t.kind],
            ['State', <Badge key="s" state={t.status} />],
            [
              'Expires',
              <span key="e" className="actions inline-actions">
                {when(t.expires_at)}
                {t.status === 'active' && t.kind === 'temporary' && (
                  <select
                    aria-label="Extend expiry"
                    value=""
                    onChange={async (e) => {
                      const days = Number(e.target.value);
                      if (!days) return;
                      try {
                        await api(`${P}/transfers/${enc(id)}`, { method: 'PATCH', body: { expires_at: inDays(days) } });
                        notice(`Now expires in ${days} day${days === 1 ? '' : 's'}.`);
                        reload();
                      } catch (err) {
                        notice((err as Error).message, true);
                      }
                    }}
                  >
                    <option value="">Change expiry…</option>
                    {[1, 3, 7, 14, 30].map((d) => (
                      <option key={d} value={d}>
                        {d} day{d === 1 ? '' : 's'} from now
                      </option>
                    ))}
                  </select>
                )}
              </span>,
            ],
            ['Files deleted', t.files_deleted_at ? when(t.files_deleted_at) : t.kind === 'temporary' ? 'at expiry' : 'kept until you delete the transfer'],
          ]}
        />
        {t.message && <p className="quote">{t.message}</p>}
      </Panel>
      {t.status === 'active' && (
        <Panel title="Add files">
          <Muted>Uploads go directly to private storage and resume if interrupted: choose the same file again to continue.</Muted>
          <div className="actions">
            <label className="button file-button primary">
              Choose files
              <input type="file" multiple onChange={(e) => void run(e.target.files).finally(() => (e.target.value = ''))} />
            </label>
            <label className="button file-button">
              Choose a folder
              <input type="file" {...({ webkitdirectory: '' } as object)} onChange={(e) => void run(e.target.files).finally(() => (e.target.value = ''))} />
            </label>
          </div>
          {pending.map((p, i) => (
            <div key={i}>
              <strong>{p.name}</strong>
              <Progress p={p.p} label={p.done} />
            </div>
          ))}
        </Panel>
      )}
      <Panel title="Files">
        {t.files.length ? (
          <Table
            head={['File', 'Size', 'Status', 'Revision', '']}
            rows={t.files.map((f: any) => [
              f.folder_path ? `${f.folder_path}/${f.name}` : f.name,
              fmtBytes(f.size),
              <Badge key="s" state={f.status} />,
              f.revision > 1 ? `rev ${f.revision}${f.replacement_note ? ` · ${f.replacement_note}` : ''}` : '—',
              <div key="a" className="actions">
                {f.status === 'available' && <Button onClick={() => ownerDownload(workspace.id, 'transfer_file', f.id)}>Download</Button>}
                {t.status === 'active' && (
                  <label className="button file-button">
                    Replace
                    <input
                      type="file"
                      aria-label={`Replace ${f.name}`}
                      onChange={(e) => void replace(f, e.target.files?.[0]).finally(() => (e.target.value = ''))}
                    />
                  </label>
                )}
                <Button
                  onClick={async () => {
                    await api(`${P}/transfers/${enc(id)}/files/${enc(f.id)}/remove`, { body: {} });
                    reload();
                  }}
                >
                  Remove
                </Button>
              </div>,
            ])}
          />
        ) : (
          <Empty>No files yet.</Empty>
        )}
      </Panel>
      <Recipients transfer={t} />
      <Panel title="Manage">
        <div className="actions">
          {t.status === 'active' && (
            <Button onClick={() => go('links', undefined, { target_type: 'transfer', target_id: id, label: t.title })}>Advanced link…</Button>
          )}
          {t.status === 'active' && (
            <Button
              kind="danger"
              onClick={async () => {
                if (!confirmAction('Revoke every link to this transfer? Copies already downloaded cannot be recalled.')) return;
                await api(`${P}/transfers/${enc(id)}/revoke`, { body: {} });
                reload();
              }}
            >
              Revoke transfer
            </Button>
          )}
          <Button
            kind="danger"
            onClick={async () => {
              if (!confirmAction('Delete this transfer and its files?')) return;
              await api(`${P}/transfers/${enc(id)}/delete`, { body: {} });
              go('transfers');
            }}
          >
            Delete transfer
          </Button>
        </div>
      </Panel>
    </>
  );
}
