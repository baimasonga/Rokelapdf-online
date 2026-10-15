'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Header } from '@/components/header';
import { Form, Panel, useNotice } from '@/components/ui';
import { useAuth } from '@/lib/client/auth';
import { safeNext } from '@/lib/client/next-path';

type Mode = 'signin' | 'signup' | 'forgot' | 'update';

function SignIn() {
  const params = useSearchParams();
  const router = useRouter();
  const notice = useNotice();
  const { supabase, session, ready, recovering, configError } = useAuth();
  const [mode, setMode] = useState<Mode>((params.get('mode') as Mode) || 'signin');
  const [sent, setSent] = useState<string>();
  const next = safeNext(params.get('next'));

  useEffect(() => {
    if (recovering) setMode('update');
  }, [recovering]);
  useEffect(() => {
    if (ready && session && mode !== 'update' && !recovering) router.replace(next);
  }, [ready, session, mode, recovering, next, router]);

  if (!ready) return <p className="muted center">Loading…</p>;
  if (configError || !supabase) return <Panel title="Sign-in unavailable">{configError}</Panel>;
  const origin = window.location.origin;
  const fail = (e: { message: string } | null) => {
    if (e) throw new Error(e.message);
  };

  if (sent) return <Panel title="Check your email">{sent}</Panel>;
  return (
    <Panel title={{ signin: 'Sign in', signup: 'Create your account', forgot: 'Reset your password', update: 'Choose a new password' }[mode]}>
      {mode === 'signin' && (
        <Form
          fields={[
            { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
            { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
          ]}
          submit="Sign in"
          onSubmit={async (v) => {
            const { error } = await supabase.auth.signInWithPassword({ email: v.email!, password: v.password! });
            fail(error);
            router.replace(next);
          }}
        />
      )}
      {mode === 'signup' && (
        <Form
          fields={[
            { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
            { name: 'password', label: 'Password', type: 'password', autoComplete: 'new-password', hint: 'At least 10 characters.' },
          ]}
          submit="Create account"
          onSubmit={async (v) => {
            if (v.password!.length < 10) throw new Error('Use at least 10 characters for your password.');
            const { data, error } = await supabase.auth.signUp({ email: v.email!, password: v.password!, options: { emailRedirectTo: `${origin}${next}` } });
            fail(error);
            if (!data.session) setSent('We sent you a confirmation link. Open it on this device to finish creating your account.');
          }}
        />
      )}
      {mode === 'forgot' && (
        <Form
          fields={[{ name: 'email', label: 'Email', type: 'email', autoComplete: 'email' }]}
          submit="Send reset link"
          onSubmit={async (v) => {
            const { error } = await supabase.auth.resetPasswordForEmail(v.email!, { redirectTo: `${origin}/signin?mode=update` });
            fail(error);
            // The same message whether or not the account exists.
            setSent('If an account exists for that address, a reset link is on its way.');
          }}
        />
      )}
      {mode === 'update' && (
        <Form
          fields={[{ name: 'password', label: 'New password', type: 'password', autoComplete: 'new-password', hint: 'At least 10 characters.' }]}
          submit="Save password"
          onSubmit={async (v) => {
            if (!session) throw new Error('Open the reset link from your email again.');
            if (v.password!.length < 10) throw new Error('Use at least 10 characters for your password.');
            const { error } = await supabase.auth.updateUser({ password: v.password! });
            fail(error);
            notice('Password updated.');
            router.replace('/app');
          }}
        />
      )}
      <p className="switch">
        {mode !== 'signin' && (
          <button type="button" className="link" onClick={() => setMode('signin')}>
            I have an account
          </button>
        )}
        {mode !== 'signup' && mode !== 'update' && (
          <button type="button" className="link" onClick={() => setMode('signup')}>
            Create an account
          </button>
        )}
        {mode === 'signin' && (
          <button type="button" className="link" onClick={() => setMode('forgot')}>
            Forgot password?
          </button>
        )}
      </p>
      <p className="muted">
        You can also <Link href="/edit">use the editor without an account</Link>.
      </p>
    </Panel>
  );
}

export default function Page() {
  return (
    <>
      <Header minimal />
      <main className="narrow">
        <Suspense fallback={<p className="muted center">Loading…</p>}>
          <SignIn />
        </Suspense>
      </main>
    </>
  );
}
