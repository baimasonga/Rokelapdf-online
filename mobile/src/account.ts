import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

// Sign-in and Word ⇄ PDF through rokelapdf.com. The server answers this app's origin (https://localhost in the
// WebView) only on /api/v1/config, /api/v1/me/access and /api/v1/convert/*; every conversion is authorized there with
// the access token. Files are converted and returned in the same response and never stored.

export const SITE = (import.meta.env.VITE_SITE_ORIGIN as string | undefined) ?? 'https://www.rokelapdf.com';

export interface SiteConfig {
  supabase_url: string;
  supabase_publishable_key: string;
  /** When the paid tools stop being free for everyone (null: not set). */
  paid_features_from: string | null;
}

let config: Promise<SiteConfig> | undefined;
/** The site's public configuration, read once per run (again after a failure). */
export function siteConfig(): Promise<SiteConfig> {
  config ??= fetch(`${SITE}/api/v1/config`, { credentials: 'omit' }).then((r) => {
    if (!r.ok) throw new Error();
    return r.json() as Promise<SiteConfig>;
  });
  config.catch(() => (config = undefined));
  return config;
}

let client: Promise<SupabaseClient> | undefined;
function supabase(): Promise<SupabaseClient> {
  client ??= siteConfig().then((c) =>
    createClient(c.supabase_url, c.supabase_publishable_key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'rokela-auth' },
    }),
  );
  client.catch(() => (client = undefined));
  return client.catch(() => {
    throw new Error('Rokela PDF cannot be reached. Check your internet connection.');
  });
}

export async function currentSession(): Promise<Session | null> {
  return (await (await supabase()).auth.getSession()).data.session;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const { data, error } = await (await supabase()).auth.signInWithPassword({ email: email.trim(), password });
  if (error || !data.session) {
    if (error?.code === 'email_not_confirmed') throw new Error('Confirm your email address first: open the link we sent you.');
    throw new Error('Email or password is not correct.');
  }
  return data.session;
}

export async function signOut() {
  await (await supabase()).auth.signOut();
}

export type Target = 'pdf' | 'docx' | 'xlsx' | 'pptx';
/** Word, Excel and PowerPoint files (and their OpenDocument equivalents) the converter turns into PDF. */
export const OFFICE_EXTENSIONS = ['docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'pptx', 'ppt', 'odp'];

/** The original base name with the new extension. */
export const renamed = (name: string, ext: Target) => `${name.replace(/\.[a-z0-9]{2,5}$/i, '').trim() || 'document'}.${ext}`;

/** Sends the file to rokelapdf.com's converter and returns the converted bytes. Needs a signed-in, confirmed account. */
export async function convert(target: Target, name: string, bytes: Uint8Array): Promise<Uint8Array> {
  const session = await currentSession();
  if (!session) throw new Error('Sign in to convert files.');
  let res: Response;
  try {
    res = await fetch(`${SITE}/api/v1/convert/${target}?name=${encodeURIComponent(name.slice(0, 255))}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/octet-stream' },
      body: bytes as BodyInit,
    });
  } catch {
    throw new Error('Rokela PDF cannot be reached. Check your internet connection.');
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    if (res.status === 401) throw new Error('Your session ended. Sign in again.');
    // Every other refusal carries a fixed, user-facing message (limits, file type, unconfirmed email…).
    throw new Error((j?.code !== 'internal' && j?.message) || 'The file could not be converted. Try again later.');
  }
  return new Uint8Array(await res.arrayBuffer());
}
