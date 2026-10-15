'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PasswordPrompt, PublicFrame, SenderBrand, SignInRequired } from '@/components/public';
import { Badge, Button, Empty, Form, Muted, Panel, useNotice } from '@/components/ui';
import { ApiError, api, enc } from '@/lib/client/api';
import { useAuth } from '@/lib/client/auth';
import { fmtBytes, when } from '@/lib/client/format';

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
  return (
    <>
      <Panel>
        <SenderBrand branding={m.branding} />
        <h1>{m.title}</h1>
        {m.message && <p className="quote">{m.message}</p>}
        {m.kind === 'document' && (
          <p>
            <Badge state={m.version.mode === 'fixed' ? m.version.label : 'published'} /> {m.version.mode !== 'fixed' && m.version.label}
            {m.version.published_at && <span className="muted"> · published {when(m.version.published_at)}</span>}
          </p>
        )}
        {m.version?.replacement_note && <p className="replacement">What changed: {m.version.replacement_note}</p>}
        {m.history?.length > 1 && (
          <Muted>
            Earlier published versions:{' '}
            {m.history
              .slice(1)
              .map((h: any) => `v${h.number}`)
              .join(', ')}
          </Muted>
        )}
        {m.expires_at && <Muted>Available until {when(m.expires_at)}</Muted>}
        {m.downloads_remaining !== null && m.downloads_remaining !== undefined && <Muted>Downloads remaining: {m.downloads_remaining}</Muted>}
      </Panel>
      <Panel title={m.kind === 'document' ? 'Document' : 'Files'}>
        {m.files.length ? (
          <ul className="file-list">
            {m.files.map((f: any) => (
              <li key={f.id}>
                <div>
                  <strong>{f.folder_path ? `${f.folder_path}/${f.name}` : f.name}</strong> <span className="muted">· {fmtBytes(f.size)}</span>
                  {f.status !== 'available' && <span className="badge off">{f.status === 'processing' ? 'being checked, available shortly' : f.status}</span>}
                  {f.replacement_note && <p className="replacement">Replaced: {f.replacement_note}</p>}
                </div>
                <div className="actions">
                  {f.viewable && (
                    <Button
                      onClick={async () => {
                        const url = await fileUrl(f.id, 'inline');
                        if (url) window.open(url, '_blank', 'noopener,noreferrer');
                      }}
                    >
                      View
                    </Button>
                  )}
                  {f.downloadable && (
                    <Button
                      kind="primary"
                      onClick={async () => {
                        const url = await fileUrl(f.id, 'attachment');
                        if (url) window.location.assign(url);
                      }}
                    >
                      Download
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No files are available yet.</Empty>
        )}
      </Panel>
      {m.permission === 'review' && <Review base={base} grant={m.grant} />}
      <Panel title="Confirm receipt">
        <p className="muted">Let the sender know you received this. A visit or download alone is not a confirmation.</p>
        {acked ? (
          <p>Receipt confirmed. Thank you.</p>
        ) : signedIn ? (
          <Button
            onClick={async () => {
              await api(`${base}/acknowledge`, { body: { grant: m.grant } });
              setAcked(true);
              notice('Receipt confirmed.');
            }}
          >
            I confirm receipt
          </Button>
        ) : (
          <Form
            fields={[{ name: 'name', label: 'Your name (shown to the sender as unverified)', autoComplete: 'name' }]}
            submit="I confirm receipt"
            onSubmit={async (v) => {
              await api(`${base}/acknowledge`, { body: { grant: m.grant, declared_name: v.name } });
              setAcked(true);
              notice('Receipt confirmed.');
            }}
          />
        )}
      </Panel>
      {m.notices?.length > 0 && (
        <Panel>
          {m.notices.map((n: string) => (
            <p key={n} className="fine-print">
              {n}
            </p>
          ))}
        </Panel>
      )}
    </>
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
