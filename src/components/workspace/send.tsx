'use client';
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { CheckCircle2, FolderPlus, Link2, Lock, Mail, Plus, Send, X } from 'lucide-react';
import { CopyField } from '@/components/ui';
import { api, enc } from '@/lib/client/api';
import { fmtBytes, inDays } from '@/lib/client/format';
import { ownerUpload, useWs } from './context';

// A WeTransfer-style send form: add files or folders, then either email a personal link to each recipient or get one
// link to share. Files go straight from the browser to private storage; links stop working when the transfer expires.

interface Item {
  id: string;
  file: File;
  /** Folder inside the transfer ('' for loose files). */
  path: string;
}
type Mode = 'email' | 'link';
interface Done {
  transferId: string;
  title: string;
  mode: Mode;
  emailed: boolean;
  links: Array<{ id: string; label: string; url: string }>;
  failed: string[];
}

const MAX_FILES = 500;
const MAX_RECIPIENTS = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let seq = 0;

/** Reads dropped files and folders (folders through the entries API, keeping their structure). */
async function droppedItems(dt: DataTransfer): Promise<Item[]> {
  const out: Item[] = [];
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...dt.files].map((file) => ({ id: `i${++seq}`, file, path: '' }));
  const walk = async (e: FileSystemEntry, dir: string): Promise<void> => {
    if (out.length > MAX_FILES) return;
    if (e.isFile) {
      const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ id: `i${++seq}`, file, path: dir });
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      const sub = dir ? `${dir}/${e.name}` : e.name;
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c, sub);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

const extOf = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? '';

export function SendPanel({ onSent }: { onSent: () => void }) {
  const { P, workspace, me, go } = useWs();
  const [items, setItems] = useState<Item[]>([]);
  const [mode, setMode] = useState<Mode>('email');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [days, setDays] = useState(7);
  const [password, setPassword] = useState('');
  const [limit, setLimit] = useState('');
  const [remind, setRemind] = useState(false);
  const [notify, setNotify] = useState(true);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState<string>();
  const [sent, setSent] = useState(0);
  const [done, setDone] = useState<Done>();
  const [cfg, setCfg] = useState<{ email: boolean; types: string[] }>();
  const [limits, setLimits] = useState<{ maxFileBytes: number; maxRetentionDays: number }>();
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api('/api/v1/config', { auth: false }).then(
      (c) => setCfg({ email: !!c.email, types: c.transfer_types ?? [] }),
      () => setCfg({ email: false, types: [] }),
    );
    api(`${P}/overview`).then(
      (o) => setLimits({ maxFileBytes: o.limits.max_file_bytes, maxRetentionDays: o.limits.max_retention_days }),
      () => undefined,
    );
  }, [P]);

  const total = items.reduce((n, i) => n + i.file.size, 0);
  const problems = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) {
      if (cfg?.types.length && !cfg.types.includes(extOf(i.file.name))) m.set(i.id, 'file type not accepted');
      else if (!i.file.size) m.set(i.id, 'empty file');
      else if (limits && i.file.size > limits.maxFileBytes) m.set(i.id, `larger than ${fmtBytes(limits.maxFileBytes)}`);
    }
    return m;
  }, [items, cfg, limits]);
  const dayChoices = [1, 3, 7, 14, 30, 90].filter((d) => d <= (limits?.maxRetentionDays ?? 7));

  const add = (more: Item[]) => {
    setError(undefined);
    setItems((cur) => {
      const next = [...cur, ...more];
      if (next.length > MAX_FILES) {
        setError(`Send up to ${MAX_FILES} files at a time.`);
        return cur;
      }
      return next;
    });
  };
  const addList = (list: FileList | null) =>
    add(
      [...(list ?? [])].map((file) => ({
        id: `i${++seq}`,
        file,
        path: file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1).join('/') : '',
      })),
    );
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    add(await droppedItems(e.dataTransfer));
  };

  const commitDraft = () => {
    const parts = draft
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!parts.length) return true;
    const bad = parts.find((p) => !EMAIL.test(p));
    if (bad) {
      setError(`“${bad}” is not an email address.`);
      return false;
    }
    const next = [...new Set([...recipients, ...parts])];
    if (next.length > MAX_RECIPIENTS) {
      setError(`Send to up to ${MAX_RECIPIENTS} people at a time.`);
      return false;
    }
    setRecipients(next);
    setDraft('');
    setError(undefined);
    return true;
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ';', ' '].includes(e.key)) {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && !draft && recipients.length) setRecipients(recipients.slice(0, -1));
  };

  const reset = () => {
    setItems([]);
    setRecipients([]);
    setDraft('');
    setTitle('');
    setMessage('');
    setPassword('');
    setLimit('');
    setDone(undefined);
    setError(undefined);
    setSent(0);
  };

  async function transfer() {
    setError(undefined);
    if (!items.length) return setError('Add at least one file.');
    if (problems.size) return setError('Remove the files marked in red first.');
    if (mode === 'email' && !commitDraft()) return;
    const to =
      mode === 'email'
        ? [
            ...new Set([
              ...recipients,
              ...draft
                .split(/[\s,;]+/)
                .filter((s) => EMAIL.test(s.toLowerCase()))
                .map((s) => s.toLowerCase()),
            ]),
          ]
        : [];
    if (mode === 'email' && !to.length) return setError('Add at least one recipient, or choose “Get a link”.');
    if (password && password.length < 8) return setError('Use a password of at least 8 characters.');
    const max = limit ? Number(limit) : undefined;
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) return setError('The download limit must be a whole number.');
    const name = title.trim() || (items.length === 1 ? items[0]!.file.name : `${items.length} files`);
    try {
      setPhase('Preparing your transfer…');
      const t = await api(`${P}/transfers`, {
        body: { title: name.slice(0, 200), ...(message.trim() ? { message: message.trim() } : {}), kind: 'temporary', expires_at: inDays(days) },
      });
      // Two files at a time; each file uploads several parts in parallel.
      const progress = new Map<string, number>();
      const failed: string[] = [];
      const queue = [...items];
      setPhase('Uploading…');
      const worker = async () => {
        for (let it = queue.shift(); it; it = queue.shift()) {
          const item = it;
          try {
            await ownerUpload(workspace.id, item.file, { target: 'transfer', transfer_id: t.id, ...(item.path ? { folder_path: item.path } : {}) }, (p) => {
              progress.set(item.id, p.sent);
              setSent([...progress.values()].reduce((a, b) => a + b, 0));
            });
          } catch (e) {
            failed.push(`${item.file.name}: ${(e as Error).message}`);
          }
        }
      };
      await Promise.all([worker(), worker()]);
      if (failed.length === items.length) throw new Error(`Nothing was uploaded. ${failed[0]}`);

      setPhase(mode === 'email' ? 'Sending…' : 'Creating your link…');
      const linkBody = {
        target_type: 'transfer',
        target_id: t.id,
        permission: 'download',
        notify_on_access: notify,
        ...(password ? { password } : {}),
        ...(max ? { max_downloads: max } : {}),
      };
      const links: Done['links'] = [];
      let emailed = false;
      if (mode === 'link') {
        const l = await api(`${P}/links`, { body: { ...linkBody, label: 'Link' } });
        links.push({ id: l.id, label: 'Link', url: l.url });
      } else {
        // One personal link per recipient, so downloads are tracked per person and a link can be revoked alone.
        for (const addr of to) {
          const l = await api(`${P}/links`, { body: { ...linkBody, label: addr } });
          links.push({ id: l.id, label: addr, url: l.url });
          if (cfg?.email && me.email_verified) {
            await api(`${P}/links/${enc(l.id)}/email`, {
              body: { to: [addr], remind_before_expiry: remind, ...(message.trim() ? { message: message.trim() } : {}) },
            });
            emailed = true;
          }
        }
      }
      setDone({ transferId: t.id, title: name, mode, emailed, links, failed });
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPhase(undefined);
    }
  }

  if (done) return <SentScreen done={done} password={!!password} onAgain={reset} onOpen={() => go('transfers', done.transferId)} sender={me.email} />;

  if (phase) {
    const pct = total ? Math.min(100, Math.round((sent / total) * 100)) : 0;
    return (
      <section className="send-card sending" aria-live="polite">
        <div
          className="ring"
          style={{ ['--pct' as string]: `${pct}` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Upload progress"
        >
          <span>{pct}%</span>
        </div>
        <h2>{phase}</h2>
        <p className="muted">
          {fmtBytes(sent)} of {fmtBytes(total)} · {items.length} file{items.length === 1 ? '' : 's'}
        </p>
        <p className="muted small">Keep this tab open until the upload finishes.</p>
      </section>
    );
  }

  const emailOff = cfg && (!cfg.email || !me.email_verified);
  return (
    <section className="send-card" aria-label="Send files">
      <div
        className={`send-drop${over ? ' over' : ''}${items.length ? ' has' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => void onDrop(e)}
      >
        {items.length ? (
          <>
            <ul className="send-files" aria-label="Files to send">
              {items.map((i) => (
                <li key={i.id} className={problems.has(i.id) ? 'bad' : ''}>
                  <span className="name" title={i.path ? `${i.path}/${i.file.name}` : i.file.name}>
                    {i.path ? <span className="muted">{i.path}/</span> : null}
                    {i.file.name}
                  </span>
                  <span className="muted">{problems.get(i.id) ?? fmtBytes(i.file.size)}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${i.file.name}`}
                    onClick={() => setItems((xs) => xs.filter((x) => x.id !== i.id))}
                  >
                    <X size={15} />
                  </button>
                </li>
              ))}
            </ul>
            <div className="send-add-row">
              <button type="button" className="button ghost" onClick={() => filesRef.current?.click()}>
                <Plus size={16} aria-hidden="true" /> Add more
              </button>
              <span className="muted">
                {items.length} file{items.length === 1 ? '' : 's'} · {fmtBytes(total)}
              </span>
            </div>
          </>
        ) : (
          <div className="send-empty">
            <button type="button" className="send-plus" aria-label="Add files" onClick={() => filesRef.current?.click()}>
              <Plus size={28} aria-hidden="true" />
            </button>
            <div>
              <strong>Add files</strong>
              <span className="muted">or drop files and folders here</span>
            </div>
            <button type="button" className="button ghost" onClick={() => folderRef.current?.click()}>
              <FolderPlus size={16} aria-hidden="true" /> Add a folder
            </button>
          </div>
        )}
        <input ref={filesRef} type="file" multiple hidden data-testid="send-files" onChange={(e) => (addList(e.target.files), (e.target.value = ''))} />
        <input ref={folderRef} type="file" hidden {...({ webkitdirectory: '' } as object)} onChange={(e) => (addList(e.target.files), (e.target.value = ''))} />
      </div>

      <div className="seg send-mode" role="radiogroup" aria-label="How to send">
        <button type="button" role="radio" aria-checked={mode === 'email'} className={mode === 'email' ? 'on' : ''} onClick={() => setMode('email')}>
          <Mail size={15} aria-hidden="true" /> Send email
        </button>
        <button type="button" role="radio" aria-checked={mode === 'link'} className={mode === 'link' ? 'on' : ''} onClick={() => setMode('link')}>
          <Link2 size={15} aria-hidden="true" /> Get a link
        </button>
      </div>

      {mode === 'email' && (
        <>
          <div className="chips" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
            {recipients.map((r) => (
              <span key={r} className="chip">
                {r}
                <button type="button" aria-label={`Remove ${r}`} onClick={() => setRecipients(recipients.filter((x) => x !== r))}>
                  <X size={12} />
                </button>
              </span>
            ))}
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              onBlur={() => draft && commitDraft()}
              placeholder={recipients.length ? 'Add another' : 'Email to'}
              aria-label="Email to"
              type="email"
              autoComplete="off"
            />
          </div>
          <p className="muted small">
            From {me.email}
            {emailOff &&
              (cfg!.email
                ? ' · confirm your email address to send emails; you will get a personal link for each person instead.'
                : ' · email delivery is not switched on yet; you will get a personal link for each person to send yourself.')}
          </p>
        </>
      )}

      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" maxLength={200} />
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message" aria-label="Message" rows={3} maxLength={2000} />

      <details className="send-options">
        <summary>
          Options · expires in {days} day{days === 1 ? '' : 's'}
          {password ? ' · password' : ''}
          {limit ? ` · ${limit} download${limit === '1' ? '' : 's'}` : ''}
        </summary>
        <label className="opt">
          <span>Expires after</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {dayChoices.map((d) => (
              <option key={d} value={d}>
                {d} day{d === 1 ? '' : 's'}
              </option>
            ))}
          </select>
          <small>Files are deleted when the transfer expires.</small>
        </label>
        <label className="opt">
          <span>
            <Lock size={13} aria-hidden="true" /> Password <em>(optional)</em>
          </span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} maxLength={128} />
        </label>
        <label className="opt">
          <span>
            Download limit <em>(optional, per link)</em>
          </span>
          <input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Unlimited" />
        </label>
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Tell me when files are downloaded (daily email digest)
        </label>
        <label className="check">
          <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} /> Email a reminder 24 hours before expiry if files have not
          been downloaded (email mode)
        </label>
      </details>

      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="button accent lg wide" onClick={() => void transfer()} disabled={!items.length}>
        <Send size={17} aria-hidden="true" /> Transfer
      </button>
    </section>
  );
}

function SentScreen({ done, password, onAgain, onOpen, sender }: { done: Done; password: boolean; onAgain: () => void; onOpen: () => void; sender: string }) {
  const mailto = (to: string, url: string) =>
    `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(`${sender} sent you ${done.title}`)}&body=${encodeURIComponent(
      `Download "${done.title}": ${url}${password ? '\n\nThe link is protected with a password; I will send it separately.' : ''}`,
    )}`;
  return (
    <section className="send-card sent" aria-live="polite">
      <CheckCircle2 size={56} className="sent-icon" aria-hidden="true" />
      <h2>{done.mode === 'link' ? 'Your link is ready' : done.emailed ? 'You’re done!' : 'Your links are ready'}</h2>
      {done.mode === 'link' ? (
        <>
          <p className="muted">Copy the link and share it. It works until the transfer expires.</p>
          <CopyField value={done.links[0]!.url} label="Transfer link" />
        </>
      ) : done.emailed ? (
        <p className="muted">
          We emailed a personal download link to {done.links.map((l) => l.label).join(', ')}. You will see each person’s downloads in the transfer.
        </p>
      ) : (
        <>
          <p className="muted">Each person has a personal link, so you can see who downloaded. Send them yourself:</p>
          <ul className="sent-links">
            {done.links.map((l) => (
              <li key={l.id}>
                <strong>{l.label}</strong>
                <CopyField value={l.url} label={`Link for ${l.label}`} />
                <a className="button ghost" href={mailto(l.label, l.url)}>
                  <Mail size={15} aria-hidden="true" /> Email it
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      {password && <p className="muted small">Remember to share the password separately.</p>}
      {done.failed.length > 0 && (
        <p className="tool-error" role="alert">
          {done.failed.length} file{done.failed.length === 1 ? '' : 's'} could not be uploaded: {done.failed.join('; ')}
        </p>
      )}
      <div className="actions">
        <button type="button" className="button primary" onClick={onAgain}>
          Send another
        </button>
        <button type="button" className="button" onClick={onOpen}>
          View transfer
        </button>
      </div>
    </section>
  );
}
