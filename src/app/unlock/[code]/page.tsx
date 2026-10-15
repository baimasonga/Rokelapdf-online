'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PasswordPrompt, PublicFrame, SignInRequired } from '@/components/public';
import { Muted, Panel } from '@/components/ui';
import { ApiError, api, enc } from '@/lib/client/api';
import { useAuth } from '@/lib/client/auth';

// Unlock page for password-protected or sign-in short links. Before leaving, the visitor sees where the link goes,
// so a link cannot silently send them somewhere unexpected.
type View = { k: 'loading' } | { k: 'password'; wrong: boolean } | { k: 'signin' } | { k: 'gone'; text: string } | { k: 'go'; location: string };

export default function Unlock() {
  const { code } = useParams<{ code: string }>();
  const { ready, session } = useAuth();
  const [view, setView] = useState<View>({ k: 'loading' });
  const unlock = useCallback(
    async (password?: string) => {
      try {
        const r = await api<{ location: string }>(`/api/v1/public/short-links/${enc(code)}/unlock`, { body: password ? { password } : {} });
        setView({ k: 'go', location: r.location });
      } catch (e) {
        const err = e as ApiError;
        if (err.code === 'unauthenticated' || err.code === 'forbidden') return setView({ k: 'signin' });
        if (err.code === 'password_required') return setView({ k: 'password', wrong: !!password });
        setView({ k: 'gone', text: err.message });
      }
    },
    [code],
  );
  useEffect(() => {
    if (ready) void unlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, session?.user.id]);

  let host = '';
  if (view.k === 'go') {
    try {
      host = new URL(view.location).host;
    } catch {
      host = '';
    }
  }
  const internal = view.k === 'go' && typeof window !== 'undefined' && host === window.location.host;
  return (
    <PublicFrame>
      {view.k === 'loading' && <Muted>Opening…</Muted>}
      {view.k === 'password' && (
        <PasswordPrompt title="Protected link" wrong={view.wrong} intro="Enter the password you were given to continue." onSubmit={(pw) => unlock(pw)} />
      )}
      {view.k === 'signin' && <SignInRequired next={`/unlock/${code}`} />}
      {view.k === 'gone' && <Panel title="Link unavailable">{view.text}</Panel>}
      {view.k === 'go' && host && (
        <Panel title={internal ? 'Link unlocked' : 'You are leaving Rokela PDF Pro'}>
          {!internal && <p>This link goes to {host}.</p>}
          <a className="button primary" href={view.location} rel="noopener noreferrer">
            Continue{internal ? '' : ` to ${host}`}
          </a>
        </Panel>
      )}
    </PublicFrame>
  );
}
