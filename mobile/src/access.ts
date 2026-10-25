import { canUsePaid, type Access } from '@/lib/licensing';
import { SITE, currentSession, siteConfig } from './account';

// The app's side of the paid tools (src/lib/licensing.ts; docs/licensing.md). The tools run on the phone, so this is
// the lock; the server only answers who has access. The last answers are kept so a person with a licence or a free
// month can keep working offline until its date, and so the free tools never wait on the network.

/** Why a paid tool cannot be used now, which decides what the prompt says. */
export type Why = 'signin' | 'trial_ended' | 'license_ended' | 'verify_email' | 'offline';

const LAUNCH_KEY = 'rokela-paid-from';
const ACCESS_KEY = 'rokela-access';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full or unavailable: the answer is just not remembered */
  }
};

/** The signed-in person's id from the stored session, readable offline (Supabase keeps it under 'rokela-auth'). */
function storedUserId(): string | undefined {
  try {
    return (JSON.parse(read('rokela-auth') ?? 'null') as { user?: { id?: string } } | null)?.user?.id;
  } catch {
    return undefined;
  }
}

/** The launch date: from the site when it answers, else the last one seen ('' when none was set). */
async function launch(): Promise<Date | null | undefined> {
  try {
    const from = (await siteConfig()).paid_features_from;
    write(LAUNCH_KEY, from ?? '');
    return from ? new Date(from) : null;
  } catch {
    const kept = read(LAUNCH_KEY);
    return kept === null ? undefined : kept ? new Date(kept) : null;
  }
}

function keptAccess(): Access | undefined {
  try {
    const kept = JSON.parse(read(ACCESS_KEY) ?? 'null') as { user: string; access: Access } | null;
    return kept && kept.user === storedUserId() ? kept.access : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves undefined when the paid tools may be used now, otherwise why not. */
export async function paidBlock(): Promise<Why | undefined> {
  const from = await launch();
  // Never online yet, or not launched: the tools are free, as they were before licences existed.
  if (from === undefined || from === null || new Date() < from) return undefined;
  let session;
  try {
    session = await currentSession();
  } catch {
    return canUsePaid(keptAccess()) ? undefined : 'offline';
  }
  if (!session) return 'signin';
  let access: Access;
  try {
    const res = await fetch(`${SITE}/api/v1/me/access`, { credentials: 'omit', headers: { authorization: `Bearer ${session.access_token}` } });
    if (res.status === 401) return 'signin';
    if (!res.ok) throw new Error();
    access = (await res.json()) as Access;
  } catch {
    return canUsePaid(keptAccess()) ? undefined : 'offline';
  }
  write(ACCESS_KEY, JSON.stringify({ user: session.user.id, access }));
  return canUsePaid(access) ? undefined : (access.reason ?? 'trial_ended');
}
