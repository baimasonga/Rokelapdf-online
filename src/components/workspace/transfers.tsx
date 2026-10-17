'use client';
import { useEffect, useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import { Badge, Button, Empty, Muted, Panel, Progress, RowMenu, ask, confirmAction, useNotice } from '@/components/ui';
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
  const copyText = async (url: string, done: string) => {
    try {
      await navigator.clipboard.writeText(url);
      notice(done);
    } catch {
      window.prompt('Copy the link:', url);
    }
  };
  const copy = async (id: string) => copyText((await api(`${P}/links/${enc(id)}`)).url, 'Link copied.');
  const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const newLink = (label: string) =>
    api(`${P}/links`, { body: { target_type: 'transfer', target_id: transfer.id, permission: 'download', notify_on_access: true, label } });
  const forward = async () => {
    const addr = to.trim().toLowerCase();
    if (!isEmail(addr)) return notice('Enter an email address.', true);
    const l = await newLink(addr);
    if (canEmail) {
      await api(`${P}/links/${enc(l.id)}/email`, { body: { to: [addr], ...(transfer.message ? { message: transfer.message } : {}) } });
      notice(`Sent to ${addr}.`);
    } else await copyText(l.url, `Personal link for ${addr} copied — send it yourself (email is not switched on yet).`);
    setTo('');
    reload();
  };
  const links: any[] = data?.items ?? [];
  return (
    <section className="ws-card" aria-labelledby="people">
      <div className="ws-card-head">
        <h2 id="people">Recipients</h2>
        {transfer.status === 'active' && (
          <button
            type="button"
            className="link-button"
            onClick={async () => {
              const l = await newLink('Link');
              reload();
              await copyText(l.url, 'New link copied.');
            }}
          >
            + New link
          </button>
        )}
      </div>
      {links.length ? (
        <ul className="people">
          {links.map((l) => {
            const name = l.label ?? 'Link';
            const email = isEmail(name);
            return (
              <li key={l.id} className={l.state === 'active' ? '' : 'off'}>
                <span className="avatar" aria-hidden="true">
                  {email ? name[0]!.toUpperCase() : <Link2 size={16} />}
                </span>
                <span className="people-main">
                  <strong>{email ? name : 'Shareable link'}</strong>
                  <span className="muted">
                    {l.state !== 'active'
                      ? l.state.replace(/_/g, ' ')
                      : l.download_count
                        ? `Downloaded ${l.download_count}×${l.max_downloads ? ` of ${l.max_downloads}` : ''}`
                        : 'Not downloaded yet'}
                    {l.has_password ? ' · password' : ''}
                  </span>
                </span>
                <span className={`dl-count${l.download_count ? ' yes' : ''}`} title="Downloads">
                  {l.download_count}
                </span>
                <RowMenu
                  label={`Actions for ${name}`}
                  items={[
                    { label: 'Copy link', onSelect: () => copy(l.id) },
                    {
                      label: 'Send email again',
                      hidden: !(canEmail && l.state === 'active' && email),
                      onSelect: async () => {
                        await api(`${P}/links/${enc(l.id)}/email`, { body: { to: [name], ...(transfer.message ? { message: transfer.message } : {}) } });
                        notice(`Email sent again to ${name}.`);
                      },
                    },
                    { label: 'View activity', onSelect: () => go('links', l.id) },
                    {
                      label: 'Stop this link',
                      danger: true,
                      hidden: l.status !== 'active',
                      onSelect: async () => {
                        if (!confirmAction(`Stop the link for ${name}? Other recipients keep access.`)) return;
                        await api(`${P}/links/${enc(l.id)}/status`, { body: { action: 'revoke' } });
                        reload();
                      },
                    },
                  ]}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">No links yet.</p>
      )}
      {transfer.status === 'active' && (
        <div className="forward">
          <input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Add someone: name@example.com"
            aria-label="Forward to"
            onKeyDown={(e) => e.key === 'Enter' && void forward()}
          />
          <Button kind="primary" onClick={forward}>
            {canEmail ? 'Send' : 'Add'}
          </Button>
        </div>
      )}
    </section>
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
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<any>();
  const { data: t, error, reload } = useLoad<any>(() => api(`${P}/transfers/${enc(id)}`), [P, id]);
  usePollWhile(!!t?.files.some((f: any) => f.status === 'processing'), reload);
  if (error) return <Panel title="Transfer">{error.message}</Panel>;
  if (!t) return <Muted>Loading…</Muted>;
  const active = t.status === 'active';
  const total = t.files.reduce((n: number, f: any) => n + (f.size ?? 0), 0);

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

  const extend = async (days: number) => {
    try {
      await api(`${P}/transfers/${enc(id)}`, { method: 'PATCH', body: { expires_at: inDays(days) } });
      notice(`Now expires in ${days} day${days === 1 ? '' : 's'}.`);
      reload();
    } catch (err) {
      notice((err as Error).message, true);
    }
  };

  return (
    <div className="tr-page">
      <button type="button" className="link-button back" onClick={() => go('transfers')}>
        ← Sent
      </button>
      <header className="tr-head">
        <div className="tr-title">
          <h2>{t.title}</h2>
          <p className="muted">
            {t.files.length} file{t.files.length === 1 ? '' : 's'} · {fmtBytes(total)} · sent {when(t.created_at)}
          </p>
        </div>
        <div className="tr-meta">
          <Badge state={t.status} />
          {active && t.kind === 'temporary' && (
            <label className="expiry">
              <span>{expiresIn(t.expires_at)}</span>
              <select aria-label="Extend expiry" value="" onChange={(e) => Number(e.target.value) && void extend(Number(e.target.value))}>
                <option value="">Change</option>
                {[1, 3, 7, 14, 30].map((d) => (
                  <option key={d} value={d}>
                    {d} day{d === 1 ? '' : 's'} from now
                  </option>
                ))}
              </select>
            </label>
          )}
          <RowMenu
            label="Transfer actions"
            items={[
              {
                label: 'Advanced link settings…',
                hidden: !active,
                onSelect: () => go('links', undefined, { target_type: 'transfer', target_id: id, label: t.title }),
              },
              {
                label: 'Stop all links',
                danger: true,
                hidden: !active,
                onSelect: async () => {
                  if (!confirmAction('Stop every link to this transfer? Copies already downloaded cannot be recalled.')) return;
                  await api(`${P}/transfers/${enc(id)}/revoke`, { body: {} });
                  reload();
                },
              },
              {
                label: 'Delete transfer',
                danger: true,
                onSelect: async () => {
                  if (!confirmAction('Delete this transfer and its files?')) return;
                  await api(`${P}/transfers/${enc(id)}/delete`, { body: {} });
                  go('transfers');
                },
              },
            ]}
          />
        </div>
      </header>
      {t.message && <p className="quote">{t.message}</p>}

      <div className="tr-grid">
        <section className="ws-card" aria-labelledby="files">
          <div className="ws-card-head">
            <h2 id="files">Files</h2>
            {active && (
              <span className="actions inline-actions">
                <button type="button" className="link-button" onClick={() => filesRef.current?.click()}>
                  + Add files
                </button>
                <button type="button" className="link-button" onClick={() => folderRef.current?.click()}>
                  + Folder
                </button>
              </span>
            )}
          </div>
          <input ref={filesRef} type="file" multiple hidden onChange={(e) => void run(e.target.files).finally(() => (e.target.value = ''))} />
          <input
            ref={folderRef}
            type="file"
            hidden
            {...({ webkitdirectory: '' } as object)}
            onChange={(e) => void run(e.target.files).finally(() => (e.target.value = ''))}
          />
          <input
            ref={replaceRef}
            type="file"
            hidden
            aria-label="Replacement file"
            onChange={(e) => void replace(replacing, e.target.files?.[0]).finally(() => (e.target.value = ''))}
          />
          {pending.map((p, i) => (
            <div key={i} className="pending">
              <strong>{p.name}</strong>
              <Progress p={p.p} label={p.done} />
            </div>
          ))}
          {t.files.length ? (
            <ul className="tr-files">
              {t.files.map((f: any) => (
                <li key={f.id}>
                  <span className="file-ext">{(/\.([a-z0-9]{1,5})$/i.exec(f.name)?.[1] ?? 'file').toUpperCase()}</span>
                  <span className="people-main">
                    <strong title={f.name}>{f.folder_path ? `${f.folder_path}/${f.name}` : f.name}</strong>
                    <span className="muted">
                      {fmtBytes(f.size)}
                      {f.revision > 1 ? ` · replaced${f.replacement_note ? `: ${f.replacement_note}` : ''}` : ''}
                    </span>
                  </span>
                  {f.status !== 'available' && <Badge state={f.status} />}
                  <RowMenu
                    label={`Actions for ${f.name}`}
                    items={[
                      { label: 'Download', hidden: f.status !== 'available', onSelect: () => ownerDownload(workspace.id, 'transfer_file', f.id) },
                      {
                        label: 'Replace with a new version…',
                        hidden: !active,
                        onSelect: () => {
                          setReplacing(f);
                          replaceRef.current?.click();
                        },
                      },
                      {
                        label: 'Remove',
                        danger: true,
                        onSelect: async () => {
                          await api(`${P}/transfers/${enc(id)}/files/${enc(f.id)}/remove`, { body: {} });
                          reload();
                        },
                      },
                    ]}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No files yet.</p>
          )}
        </section>
        <Recipients transfer={t} />
      </div>
    </div>
  );
}
