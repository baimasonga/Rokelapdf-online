'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Clock, FileInput, RotateCw, Trash2, Upload } from 'lucide-react';
import { PasswordPrompt, PublicFrame, SenderBrand } from '@/components/public';
import { Button, Form, Muted, Panel, Progress, useNotice } from '@/components/ui';
import { ApiError, api, enc } from '@/lib/client/api';
import { fmtBytes } from '@/lib/client/format';
import { fileKey, uploadFile, type UploadProgress } from '@/lib/client/uploader';

/* eslint-disable @typescript-eslint/no-explicit-any */
// The submission secret is held in memory only (never in browser storage): an interrupted upload resumes within this
// page, but a reload starts a new submission. It grants access only to this submitter's own files.
const STATES: Record<string, string> = {
  closed: 'This request is closed.',
  deadline_passed: 'The deadline for this request has passed.',
  suspended: 'This request is suspended.',
};

type View =
  { k: 'loading' } | { k: 'password'; wrong: boolean } | { k: 'gone'; title: string; text: string } | { k: 'start' } | { k: 'files'; sub: any } | { k: 'sent' };

export default function UploadRequestPage() {
  const { token } = useParams<{ token: string }>();
  const base = `/api/v1/public/upload-requests/${enc(token)}`;
  const notice = useNotice();
  const [info, setInfo] = useState<any>();
  const [secret, setSecret] = useState('');
  const [view, setView] = useState<View>({ k: 'loading' });
  const [progress, setProgress] = useState<Record<string, UploadProgress | undefined>>({});
  const uploading = useRef(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<Record<string, File | undefined>>({});
  const [syncNeeded, setSyncNeeded] = useState(false);
  const h = useCallback((s = secret) => ({ 'x-submission-secret': s }), [secret]);

  const open = useCallback(
    async (pw?: string) => {
      try {
        setInfo(await api(`${base}/open`, { auth: false, body: pw ? { password: pw } : {} }));
        setView({ k: 'start' });
      } catch (e) {
        const err = e as ApiError;
        if (err.code === 'password_required') return setView({ k: 'password', wrong: err.message === 'incorrect password' });
        if (err.code === 'link_unavailable')
          return setView({ k: 'gone', title: 'Not accepting files', text: STATES[(err.details?.state as string) ?? ''] ?? 'This request is not available.' });
        setView({ k: 'gone', title: 'Request not found', text: 'Check that you copied the whole link.' });
      }
    },
    [base],
  );
  useEffect(() => {
    void open();
  }, [open]);

  const refresh = async (s = secret) => {
    const sub = await api(`${base}/submission`, { auth: false, headers: h(s) });
    setView(sub.status === 'submitted' ? { k: 'sent' } : { k: 'files', sub });
    setSyncNeeded(false);
  };

  const processing = view.k === 'files' && view.sub.files.some((f: any) => f.status === 'processing');
  useEffect(() => {
    if ((!processing && !syncNeeded) || busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const sub = await api(`${base}/submission`, { auth: false, headers: h() });
        if (active && !uploading.current) {
          setView(sub.status === 'submitted' ? { k: 'sent' } : { k: 'files', sub });
          setSyncNeeded(false);
        }
      } catch {
        // Keep the current file state during a temporary connection failure.
      }
      if (active) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [base, busy, h, processing, syncNeeded]);

  const upload = async (r: any, file: File | undefined) => {
    if (!file || uploading.current || syncNeeded) return;
    const mine = view.k === 'files' ? view.sub.files.filter((f: any) => f.requirement_key === r.key) : [];
    // A full slot only takes the interrupted upload holding it back, which resumes from where it stopped, or a retry,
    // which may only need to confirm an upload the server finished while its answer was lost.
    if (mine.length >= r.max_files && file !== retry[r.key] && !mine.some((f: any) => f.status === 'uploading' && f.size === file.size)) {
      notice('Remove the interrupted upload first, or choose the same file again to resume it.', true);
      return;
    }
    uploading.current = true;
    setBusy(true);
    setRetry((x) => ({ ...x, [r.key]: undefined }));
    try {
      await uploadFile({
        file,
        resumeKey: fileKey(`${token}:${r.key}`, file),
        begin: () => api(`${base}/uploads`, { auth: false, body: { requirement_key: r.key, name: file.name, size: file.size }, headers: h() }),
        status: (id) => api(`${base}/uploads/${enc(id)}`, { auth: false, headers: h() }),
        sign: (id, nums) => api(`${base}/uploads/${enc(id)}/parts`, { auth: false, body: { part_numbers: nums }, headers: h() }),
        complete: (id) => api(`${base}/uploads/${enc(id)}/complete`, { auth: false, body: {}, headers: h() }),
        onProgress: (p) => setProgress((x) => ({ ...x, [r.key]: p })),
      });
      await refresh().catch((e) => {
        setSyncNeeded(true);
        notice((e as Error).message, true);
      });
    } catch (e) {
      setRetry((x) => ({ ...x, [r.key]: file }));
      notice((e as Error).message, true);
      await refresh().catch(() => setSyncNeeded(true));
    } finally {
      setProgress((x) => ({ ...x, [r.key]: undefined }));
      uploading.current = false;
      setBusy(false);
    }
  };

  const intro = info && (
    <section className="share-card">
      <SenderBrand branding={info.branding} />
      <span className="tile-icon share-icon" aria-hidden="true">
        <FileInput size={28} />
      </span>
      <h1>{info.title}</h1>
      {info.instructions && <p className="share-message">{info.instructions}</p>}
      <p className="share-facts">
        {info.deadline && (
          <span>
            <Clock size={14} aria-hidden="true" /> Due {new Date(info.deadline).toLocaleString()}
          </span>
        )}
        <span>Up to {fmtBytes(info.max_file_bytes)} per file</span>
      </p>
    </section>
  );
  const notices = info?.notices?.length > 0 && (
    <div className="share-notices">
      {info.notices.map((n: string) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );

  return (
    <PublicFrame>
      {view.k === 'loading' && <Muted>Opening…</Muted>}
      {view.k === 'password' && (
        <PasswordPrompt title="Password required" wrong={view.wrong} intro="The requester protected this page with a password." onSubmit={(pw) => open(pw)} />
      )}
      {view.k === 'gone' && <Panel title={view.title}>{view.text}</Panel>}
      {view.k === 'start' && (
        <>
          {intro}
          <section className="share-ack req-start">
            <h2>Who is sending these files?</h2>
            <Form
              fields={[
                { name: 'name', label: 'Your name', autoComplete: 'name' },
                { name: 'email', label: 'Your email', type: 'email', optional: true, autoComplete: 'email' },
              ]}
              submit="Start"
              onSubmit={async (v) => {
                const r = await api(`${base}/submissions`, { auth: false, body: { grant: info.grant, name: v.name, ...(v.email ? { email: v.email } : {}) } });
                setSecret(r.submission_secret);
                await refresh(r.submission_secret);
              }}
            />
          </section>
          {notices}
        </>
      )}
      {view.k === 'files' && (
        <>
          {intro}
          <ol className="reqs" aria-label="Files to send">
            {info.requirements.map((r: any, i: number) => {
              const mine = view.sub.files.filter((f: any) => f.requirement_key === r.key);
              const done = mine.some((f: any) => f.status === 'available');
              // An interrupted upload keeps its slot, but the same file can be chosen again to resume it.
              const canAdd = mine.length < r.max_files || mine.some((f: any) => f.status === 'uploading');
              return (
                <li
                  key={r.key}
                  className={`req${done ? ' done' : ''}`}
                  onDragOver={(e) => !busy && !syncNeeded && canAdd && e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!busy && !syncNeeded && canAdd) void upload(r, e.dataTransfer.files[0]);
                  }}
                >
                  <span className="req-mark" aria-hidden="true">
                    {done ? <Check size={16} /> : i + 1}
                  </span>
                  <div className="req-body">
                    <strong>
                      {r.label}
                      {r.required ? '' : ' (optional)'}
                    </strong>
                    <span className="muted small">
                      {r.accept.map((x: string) => x.toUpperCase()).join(', ')} · up to {r.max_files} file{r.max_files === 1 ? '' : 's'}
                    </span>
                    {mine.length > 0 && (
                      <ul className="req-files">
                        {mine.map((f: any) => (
                          <li key={f.id}>
                            <span className="file-ext sm">{(/\.([a-z0-9]{1,5})$/i.exec(f.name)?.[1] ?? 'file').toUpperCase()}</span>
                            <span className="req-file-name">{`${f.name} · ${fmtBytes(f.size)} · ${f.status === 'processing' ? 'received, being checked' : f.status === 'available' ? 'Ready' : f.status === 'rejected' || f.status === 'deleted' ? 'Not accepted — remove and replace' : 'Upload interrupted'}`}</span>
                            <Button
                              kind="ghost"
                              title={`Remove ${f.name}`}
                              disabled={busy || syncNeeded}
                              onClick={async () => {
                                if (uploading.current) return;
                                uploading.current = true;
                                setBusy(true);
                                try {
                                  await api(`${base}/submission/files/${enc(f.id)}`, { method: 'DELETE', auth: false, headers: h() });
                                  setRetry((x) => ({ ...x, [r.key]: undefined }));
                                  await refresh().catch((e) => {
                                    setSyncNeeded(true);
                                    throw e;
                                  });
                                } finally {
                                  uploading.current = false;
                                  setBusy(false);
                                }
                              }}
                            >
                              <Trash2 size={16} aria-label={`Remove ${f.name}`} />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <Progress p={progress[r.key]} />
                    {retry[r.key] && (
                      <div className="actions">
                        <Button disabled={busy || syncNeeded} onClick={() => upload(r, retry[r.key])}>
                          <RotateCw size={16} aria-hidden="true" /> Retry {retry[r.key]!.name}
                        </Button>
                        {!mine.some((f: any) => f.status === 'uploading' && f.name === retry[r.key]!.name && f.size === retry[r.key]!.size) && (
                          <Button disabled={busy || syncNeeded} onClick={() => setRetry((x) => ({ ...x, [r.key]: undefined }))}>
                            Discard retry
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  {canAdd && (
                    <label className="button file-button req-pick">
                      <Upload size={16} aria-hidden="true" /> {done ? 'Add another' : 'Choose file'}
                      <input
                        type="file"
                        disabled={busy || syncNeeded}
                        accept={r.accept.map((x: string) => `.${x}`).join(',')}
                        aria-label={`Upload ${r.label}`}
                        onChange={(e) => void upload(r, e.target.files?.[0]).finally(() => (e.target.value = ''))}
                      />
                    </label>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="req-send">
            <Button
              kind="primary"
              disabled={
                busy ||
                syncNeeded ||
                Object.values(retry).some(Boolean) ||
                view.sub.files.some((f: any) => ['uploading', 'rejected', 'deleted'].includes(f.status))
              }
              onClick={async () => {
                if (uploading.current) return;
                uploading.current = true;
                setBusy(true);
                try {
                  await api(`${base}/submission/submit`, { auth: false, body: {}, headers: h() });
                  await refresh();
                } catch (e) {
                  const missing = (e as ApiError).details?.missing as string[] | undefined;
                  if (missing) throw new Error(`Still needed: ${missing.map((k) => info.requirements.find((r: any) => r.key === k)?.label ?? k).join(', ')}`);
                  throw e;
                } finally {
                  uploading.current = false;
                  setBusy(false);
                }
              }}
            >
              Send files
            </Button>
            <span className="muted small">You can drop a file onto an item to upload it.</span>
          </div>
          {notices}
        </>
      )}
      {view.k === 'sent' && (
        <section className="share-card">
          <span className="done-check" aria-hidden="true">
            <CheckCircle2 size={44} />
          </span>
          <h1>Files sent</h1>
          <p className="muted">Thank you. Your submission was received and the requester was notified. Files become available after security checks finish.</p>
        </section>
      )}
    </PublicFrame>
  );
}
