'use client';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setTokenProvider } from './api';

// Supabase Auth in the browser: sign-in, sign-up, password reset and token refresh. The access token is attached to
// API calls; the server verifies it with Supabase on every request and never trusts anything else from the client.

interface AuthState {
  ready: boolean;
  supabase: SupabaseClient | undefined;
  session: Session | null;
  /** Set after a password-recovery link was opened. */
  recovering: boolean;
  configError: string | undefined;
  signOut(): Promise<void>;
}
const Ctx = createContext<AuthState | undefined>(undefined);

let clientPromise: Promise<SupabaseClient> | undefined;
function supabaseClient(): Promise<SupabaseClient> {
  clientPromise ??= api<{ supabase_url: string; supabase_publishable_key: string }>('/api/v1/config', { auth: false }).then((c) =>
    createClient(c.supabase_url, c.supabase_publishable_key, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'rokela-auth' },
    }),
  );
  clientPromise.catch(() => (clientPromise = undefined));
  return clientPromise;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [supabase, setSupabase] = useState<SupabaseClient>();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [configError, setConfigError] = useState<string>();

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;
    supabaseClient()
      .then(async (sb) => {
        if (cancelled) return;
        setTokenProvider(async () => (await sb.auth.getSession()).data.session?.access_token);
        setSupabase(sb);
        const { data } = sb.auth.onAuthStateChange((event, s) => {
          setSession(s);
          if (event === 'PASSWORD_RECOVERY') setRecovering(true);
          if (event === 'SIGNED_OUT') setRecovering(false);
        });
        unsub = () => data.subscription.unsubscribe();
        setSession((await sb.auth.getSession()).data.session);
        setReady(true);
      })
      .catch(() => {
        setConfigError('Sign-in is unavailable right now. Try again later.');
        setReady(true);
      });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      supabase,
      session,
      recovering,
      configError,
      signOut: async () => {
        await supabase?.auth.signOut();
        setSession(null);
      },
    }),
    [ready, supabase, session, recovering, configError],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
