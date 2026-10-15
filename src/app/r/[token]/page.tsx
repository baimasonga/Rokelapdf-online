'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PasswordPrompt, PublicFrame, SenderBrand } from '@/components/public';
import { Button, Form, Muted, Panel, Progress, useNotice } from '@/components/ui';
import { ApiError, api, enc } from '@/lib/client/api';
import { fmtBytes, when } from '@/lib/client/format';
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
  };

  const upload = async (r: any, file: File | undefined) => {
    if (!file) return;
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
      setProgress((x) => ({ ...x, [r.key]: undefined }));
      await refresh();
    } catch (e) {
      notice((e as Error).message, true);
    }
  };

  const intro = info && (
    <Panel>
      <SenderBrand branding={info.branding} />
      <h1>{info.title}</h1>
      {info.instructions && <p className="quote">{info.instructions}</p>}
      <Muted>
        Deadline: {when(info.deadline)} · Largest file {fmtBytes(info.max_file_bytes)}
      </Muted>
      {info.notices?.map((n: string) => (
        <p key={n} className="fine-print">
          {n}
        </p>
      ))}
    </Panel>
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
          <Panel title="Who is sending these files?">
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
          </Panel>
        </>
      )}
      {view.k === 'files' && (
        <>
          {intro}
          <Panel title="Files">
            {info.requirements.map((r: any) => {
              const mine = view.sub.files.filter((f: any) => f.requirement_key === r.key);
              return (
                <div key={r.key} className="requirement">
                  <h3>
                    {r.label}
                    {r.required ? ' (required)' : ''}
                  </h3>
                  <p className="fine-print">
                    Accepted: {r.accept.join(', ')} · up to {r.max_files} file(s)
                  </p>
                  {mine.map((f: any) => (
                    <p key={f.id}>
                      {f.name} · {fmtBytes(f.size)} · {f.status === 'processing' ? 'received, being checked' : f.status}
                    </p>
                  ))}
                  {mine.length < r.max_files && (
                    <label className="button file-button">
                      Choose file
                      <input
                        type="file"
                        accept={r.accept.map((x: string) => `.${x}`).join(',')}
                        aria-label={`Upload ${r.label}`}
                        onChange={(e) => void upload(r, e.target.files?.[0]).finally(() => (e.target.value = ''))}
                      />
                    </label>
                  )}
                  <Progress p={progress[r.key]} />
                </div>
              );
            })}
          </Panel>
          <Panel>
            <Button
              kind="primary"
              onClick={async () => {
                try {
                  await api(`${base}/submission/submit`, { auth: false, body: {}, headers: h() });
                  await refresh();
                } catch (e) {
                  const missing = (e as ApiError).details?.missing as string[] | undefined;
                  if (missing) throw new Error(`Still needed: ${missing.map((k) => info.requirements.find((r: any) => r.key === k)?.label ?? k).join(', ')}`);
                  throw e;
                }
              }}
            >
              Send files
            </Button>
          </Panel>
        </>
      )}
      {view.k === 'sent' && (
        <>
          {intro}
          <Panel title="Files sent">Thank you. The requester has been notified.</Panel>
        </>
      )}
    </PublicFrame>
  );
}
