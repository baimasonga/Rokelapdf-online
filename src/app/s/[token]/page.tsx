'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Clock, Download, Eye, FileArchive, FileText, Files } from 'lucide-react';
import { PasswordPrompt, PublicFrame, SenderBrand, SignInRequired } from '@/components/public';
import { Badge, Button, Empty, Form, Modal, Muted, Panel, useNotice } from '@/components/ui';
import { PagePicker } from '@/components/tools/page-picker';
import { IN_MEMORY_LIMIT, downloadZip, pickSaveTarget } from '@/lib/client/zip-download';
import { ApiError, api, enc } from '@/lib/client/api';
import { useAuth } from '@/lib/client/auth';
import { fmtBytes } from '@/lib/client/format';

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATES: Record<string, string> = {
  revoked: 'The sender revoked this link.',
  suspended: 'This link is suspended.',
  expired: 'This link has expired.',
  unavailable: 'The shared files are no longer available.',
  not_published: 'The sender has not published this document yet.',
  download_limit_reached: 'The download limit for this link has been reached.',
};

type View = { k: 'loading' } | { k: 'password'; wrong: boolean } | { k: 'signin' } | { k: 'gone'; text: string; title: string } | { k: 'ok'; m: any };

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const base = `/api/v1/public/shares/${enc(token)}`;
  const { ready, session } = useAuth();
  const notice = useNotice();
  const [password, setPassword] = useState('');
  const [view, setView] = useState<View>({ k: 'loading' });

  const open = useCallback(
    async (pw = password) => {
      try {
        setView({ k: 'ok', m: await api(`${base}/open`, { body: pw ? { password: pw } : {} }) });
      } catch (e) {
        const err = e as ApiError;
        if (err.code === 'password_required') return setView({ k: 'password', wrong: err.message === 'incorrect password' });
        if (err.code === 'unauthenticated' || err.code === 'forbidden') return setView({ k: 'signin' });
        if (err.code === 'link_unavailable')
          return setView({ k: 'gone', title: 'Link unavailable', text: STATES[(err.details?.state as string) ?? ''] ?? 'This link is not available.' });
        if (err.status === 404) return setView({ k: 'gone', title: 'Link not found', text: 'Check that you copied the whole link.' });
        setView({ k: 'gone', title: 'Could not open the link', text: err.message });
      }
    },
    [base, password],
  );
  useEffect(() => {
    if (ready) void open();
    // Re-open when the visitor signs in or out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, session?.user.id]);

  const fileUrl = async (m: any, fileId: string, disposition: 'inline' | 'attachment') => {
    try {
      return (await api(`${base}/files/url`, { body: { grant: m.grant, file_id: fileId, disposition } })).url as string;
    } catch (e) {
      if ((e as ApiError).code === 'unauthenticated') {
        await open();
        notice('Your access was refreshed. Try again.');
        return undefined;
      }
      throw e;
    }
  };

  return (
    <PublicFrame>
      {view.k === 'loading' && <Muted>Opening…</Muted>}
      {view.k === 'password' && (
        <PasswordPrompt
          title="Password required"
          wrong={view.wrong}
          intro="The sender protected this link with a password."
          onSubmit={async (pw) => {
            setPassword(pw);
            await open(pw);
          }}
        />
      )}
      {view.k === 'signin' && <SignInRequired next={`/s/${token}`} />}
      {view.k === 'gone' && <Panel title={view.title}>{view.text}</Panel>}
      {view.k === 'ok' && <Manifest m={view.m} base={base} fileUrl={(id, d) => fileUrl(view.m, id, d)} signedIn={!!session} />}
    </PublicFrame>
  );
}

function Manifest({
  m,
  base,
  fileUrl,
  signedIn,
}: {
  m: any;
  base: string;
  fileUrl: (id: string, d: 'inline' | 'attachment') => Promise<string | undefined>;
  signedIn: boolean;
}) {
  const notice = useNotice();
  const [acked, setAcked] = useState(false);
  const [zipping, setZipping] = useState<{ done: number; total: number }>();
  const [preview, setPreview] = useState<any>();
  const ready = m.files.filter((f: any) => f.downloadable);
  const totalBytes = m.files.reduce((n: number, f: any) => n + (f.size ?? 0), 0);

  async function downloadAll() {
    if (ready.length === 1) {
      const url = await fileUrl(ready[0].id, 'attachment');
      if (url) window.location.assign(url);
      return;
    }
    const name = `${(m.title || 'files').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100)}.zip`;
    const target = await pickSaveTarget(name);
    if (target === null) return; // cancelled
    const size = ready.reduce((n: number, f: any) => n + f.size, 0);
    if (!target && size > IN_MEMORY_LIMIT) {
      notice('This set is too large to zip in this browser. Download the files one by one, or use Chrome or Edge.', true);
      return;
    }
    setZipping({ done: 0, total: size });
    try {
      const a = await api(`${base}/archive`, { body: { grant: m.grant } });
      await downloadZip(
        a.files.map((f: any) => ({ name: f.name, folderPath: f.folder_path, url: f.url, size: f.size })),
        name,
        target,
        (done, total) => setZipping({ done, total }),
      );
      notice('Download complete.');
    } catch (e) {
      notice((e as Error).message, true);
    } finally {
      setZipping(undefined);
    }
  }

  const isTransfer = m.kind === 'transfer';
  const docFile = !isTransfer ? m.files[0] : undefined;
  const expires = m.transfer_expires_at ?? m.expires_at;
  return (
    <>
      <section className="share-card">
        <SenderBrand branding={m.branding} />
        <span className="tile-icon share-icon" aria-hidden="true">
          {isTransfer ? <Files size={28} /> : <FileText size={28} />}
        </span>
        <h1>{m.title}</h1>
        {m.message && <p className="share-message">{m.message}</p>}
        <p className="share-facts">
          {isTransfer ? (
            <span>
              {m.files.length} file{m.files.length === 1 ? '' : 's'} · {fmtBytes(totalBytes)}
            </span>
          ) : (
            <span>Version {m.version.number}</span>
          )}
          {expires && (
            <span>
              <Clock size={14} aria-hidden="true" /> Available until {new Date(expires).toLocaleDateString()}
            </span>
          )}
          {m.downloads_remaining !== null && m.downloads_remaining !== undefined && (
            <span>
              <Download size={14} aria-hidden="true" /> {m.downloads_remaining} download{m.downloads_remaining === 1 ? '' : 's'} left
            </span>
          )}
        </p>
        {isTransfer && ready.length > 0 && (
          <div className="share-download">
            <button type="button" className="button primary xl" disabled={!!zipping} onClick={() => void downloadAll()}>
              {ready.length > 1 ? <FileArchive size={22} aria-hidden="true" /> : <Download size={22} aria-hidden="true" />}
              {zipping
                ? `Downloading… ${zipping.total ? Math.round((zipping.done / zipping.total) * 100) : 0}%`
                : ready.length > 1
                  ? 'Download all'
                  : 'Download'}
            </button>
            {zipping && <progress max={zipping.total || 1} value={zipping.done} aria-label="Download progress" />}
          </div>
        )}
        {docFile && (
          <div className="share-download">
            {docFile.downloadable && (
              <button
                type="button"
                className="button primary xl"
                onClick={async () => {
                  const url = await fileUrl(docFile.id, 'attachment');
                  if (url) window.location.assign(url);
                }}
              >
                <Download size={22} aria-hidden="true" /> Download
              </button>
            )}
            {docFile.viewable && (
              <button type="button" className="button" onClick={() => setPreview({ ...docFile, content_type: 'application/pdf' })}>
                <Eye size={16} aria-hidden="true" /> {m.permission === 'view' ? 'View' : 'Preview'}
              </button>
            )}
            {docFile.status !== 'available' && (
              <span className="badge off">{docFile.status === 'processing' ? 'Being checked, available shortly' : docFile.status}</span>
            )}
          </div>
        )}
        {m.kind === 'document' && m.version.mode !== 'fixed' && <p className="fine-print">{m.version.label}</p>}
        {m.version?.replacement_note && <p className="replacement">What changed: {m.version.replacement_note}</p>}

        {isTransfer && (
          <ul className="share-files" aria-label="Files">
            {m.files.map((f: any) => (
              <li key={f.id}>
                <span className="file-ext">{(/\.([a-z0-9]{1,5})$/i.exec(f.name)?.[1] ?? 'file').toUpperCase()}</span>
                <span className="people-main">
                  <strong title={f.name}>{f.folder_path ? `${f.folder_path}/${f.name}` : f.name}</strong>
                  <span className="muted">
                    {fmtBytes(f.size)}
                    {f.status !== 'available' ? ` · ${f.status === 'processing' ? 'being checked, available shortly' : f.status}` : ''}
                    {f.replacement_note ? ` · replaced: ${f.replacement_note}` : ''}
                  </span>
                </span>
                {f.viewable && (
                  <button type="button" className="icon-button lg" aria-label={`Preview ${f.name}`} title="Preview" onClick={() => setPreview(f)}>
                    <Eye size={18} />
                  </button>
                )}
                {f.downloadable && (
                  <button
                    type="button"
                    className="icon-button lg"
                    aria-label={`Download ${f.name}`}
                    title="Download"
                    onClick={async () => {
                      const url = await fileUrl(f.id, 'attachment');
                      if (url) window.location.assign(url);
                    }}
                  >
                    <Download size={18} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <Modal open={!!preview} onClose={() => setPreview(undefined)} title={preview?.name ?? 'Preview'}>
        {preview && <Preview key={preview.id} file={preview} fileUrl={fileUrl} />}
      </Modal>
      {m.permission === 'review' && <Review base={base} grant={m.grant} />}
      <section className="share-ack">
        {acked ? (
          <p>Receipt confirmed. Thank you.</p>
        ) : signedIn ? (
          <>
            <p>Let the sender know you received this.</p>
            <Button
              onClick={async () => {
                await api(`${base}/acknowledge`, { body: { grant: m.grant } });
                setAcked(true);
                notice('Receipt confirmed.');
              }}
            >
              I confirm receipt
            </Button>
          </>
        ) : (
          <>
            <p>Let the sender know you received this (a download alone is not a confirmation).</p>
            <Form
              fields={[{ name: 'name', label: 'Your name (shown to the sender as unverified)', autoComplete: 'name' }]}
              submit="I confirm receipt"
              onSubmit={async (v) => {
                await api(`${base}/acknowledge`, { body: { grant: m.grant, declared_name: v.name } });
                setAcked(true);
                notice('Receipt confirmed.');
              }}
            />
          </>
        )}
      </section>
      {m.notices?.length > 0 && (
        <div className="share-notices">
          {m.notices.map((n: string) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
    </>
  );
}

/** In-page preview of an image, PDF or text file; fetched from its signed inline URL (counted as a view). */
function Preview({ file, fileUrl }: { file: any; fileUrl: (id: string, d: 'inline' | 'attachment') => Promise<string | undefined> }) {
  const [state, setState] = useState<{ url?: string; img?: string; pdf?: Uint8Array; text?: string; error?: string }>({});
  useEffect(() => {
    let live = true;
    let objectUrl: string | undefined;
    (async () => {
      const url = await fileUrl(file.id, 'inline');
      if (!url || !live) return;
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error('The preview could not be loaded.');
      const type = String(file.content_type ?? '');
      if (type.startsWith('image/')) {
        objectUrl = URL.createObjectURL(await res.blob());
        if (live) setState({ url, img: objectUrl });
      } else if (type === 'application/pdf') {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (live) setState({ url, pdf: bytes });
      } else {
        const text = (await res.text()).slice(0, 100_000);
        if (live) setState({ url, text });
      }
    })().catch((e: Error) => live && setState({ error: e.message }));
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // Load once per file: `fileUrl` is recreated on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);
  if (state.error) return <p className="tool-error">{state.error}</p>;
  if (!state.url) return <Muted>Loading preview…</Muted>;
  return (
    <div className="preview">
      {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: URL of the shared image */}
      {state.img && <img src={state.img} alt={file.name} />}
      {state.pdf && <PagePicker bytes={state.pdf} />}
      {state.text !== undefined && <pre>{state.text}</pre>}
      <a href={state.url} target="_blank" rel="noopener noreferrer" className="button ghost">
        Open in a new tab
      </a>
    </div>
  );
}

function Review({ base, grant }: { base: string; grant: string }) {
  const [t, setT] = useState<any>();
  const load = useCallback(async () => setT(await api(`${base}/comments`, { headers: { 'x-share-grant': grant } })), [base, grant]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);
  const decide = (decision: string) => async () => {
    await api(`${base}/review`, { body: { grant, decision } });
    await load();
  };
  return (
    <Panel title="Review">
      {!t ? (
        <Muted>Loading comments…</Muted>
      ) : t.comments.length ? (
        t.comments.map((c: any, i: number) => (
          <p key={i}>
            <strong>{c.author}</strong>
            {c.page ? ` · page ${c.page}` : ''}: {c.body}
          </p>
        ))
      ) : (
        <Empty>No comments yet.</Empty>
      )}
      {t?.reviews.map((r: any, i: number) => (
        <p key={`r${i}`}>
          <Badge state={r.decision} /> {r.reviewer}
        </p>
      ))}
      <Form
        fields={[
          { name: 'body', label: 'Comment', type: 'textarea' },
          { name: 'page', label: 'Page', type: 'number', optional: true, min: 1 },
        ]}
        submit="Add comment"
        onSubmit={async (v) => {
          await api(`${base}/comments`, { body: { grant, body: v.body, ...(v.page ? { page: Number(v.page) } : {}) } });
          await load();
        }}
      />
      <div className="actions">
        <Button kind="primary" onClick={decide('approved')}>
          Approve this version
        </Button>
        <Button onClick={decide('changes_requested')}>Request changes</Button>
      </div>
    </Panel>
  );
}
