'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { sessionToken } from '@/lib/client/auth';
import { COMPANY } from '@/lib/company';
import { FEATURE_NAMES, TRIAL_DAYS, canUsePaid, type Access, type PaidFeature } from '@/lib/licensing';
import { Modal } from './ui';

// The website's side of the paid tools (src/lib/licensing.ts; docs/licensing.md). A paid tool calls `require` before it
// starts; when the person may not use it yet, a prompt says why and what to do. The tools themselves run in the
// browser, so this is the lock: the server only answers who has access.

let launch: Promise<Date | null> | undefined;
/** The launch date once known (null: not set); undefined until the configuration has been read. */
let launchKnown: Date | null | undefined;
/** When the paid tools stop being free for everyone (null: not set). Read once per page load. */
function launchDate(): Promise<Date | null> {
  launch ??= api<{ paid_features_from: string | null }>('/api/v1/config', { auth: false }).then((c) => {
    launchKnown = c.paid_features_from ? new Date(c.paid_features_from) : null;
    return launchKnown;
  });
  launch.catch(() => (launch = undefined));
  return launch;
}
/** True when the paid tools are known to be free right now, so a tool can start in the same click. */
const knownOpen = () => launchKnown !== undefined && (launchKnown === null || new Date() < launchKnown);

type Why = 'signin' | 'trial_ended' | 'license_ended' | 'verify_email' | 'error';

/**
 * `require` answers synchronously (true) while the paid tools are free for everyone and the launch date is already
 * known, so a tool picked in the editor is active for the very next click; otherwise it asks the server first.
 */
export function usePaid(): { require: (f: PaidFeature) => boolean | Promise<boolean>; prompt: ReactNode } {
  const [blocked, setBlocked] = useState<{ feature: PaidFeature; why: Why }>();
  // Read the launch date as soon as a page with paid tools opens, not on the first click.
  useEffect(() => void launchDate().catch(() => undefined), []);
  const check = useCallback(async (feature: PaidFeature) => {
    try {
      const from = await launchDate();
      if (!from || new Date() < from) return true;
      const token = await sessionToken();
      if (!token) return (setBlocked({ feature, why: 'signin' }), false);
      const a = await api<Access>('/api/v1/me/access', { auth: false, headers: { authorization: `Bearer ${token}` } });
      if (canUsePaid(a)) return true;
      setBlocked({ feature, why: a.reason ?? 'trial_ended' });
    } catch (e) {
      // An expired session is a sign-in matter, not a network one.
      setBlocked({ feature, why: e instanceof ApiError && e.status === 401 ? 'signin' : 'error' });
    }
    return false;
  }, []);
  const require = useCallback((feature: PaidFeature) => (knownOpen() ? true : check(feature)), [check]);
  const prompt = blocked ? <PaidPrompt feature={blocked.feature} why={blocked.why} onClose={() => setBlocked(undefined)} /> : null;
  return { require, prompt };
}

const PRO = Object.values(FEATURE_NAMES)
  .map((n, i, all) => (i === 0 ? n : i === all.length - 1 ? ` and ${n.toLowerCase()}` : `, ${n.toLowerCase()}`))
  .join('');

function PaidPrompt({ feature, why, onClose }: { feature: PaidFeature; why: Why; onClose: () => void }) {
  const here = typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;
  const buy = (
    <p>
      <a className="button primary" href={`mailto:${COMPANY.email}?subject=${encodeURIComponent('Rokela PDF licence')}`}>
        Get a licence
      </a>{' '}
      <span className="muted">Email {COMPANY.email} from the address you sign in with.</span>
    </p>
  );
  const body: Record<Why, ReactNode> = {
    signin: (
      <>
        <p>Sign in to use it. Every new account gets {TRIAL_DAYS} days of every Pro tool free.</p>
        <p>
          <Link className="button primary" href={`/signin?next=${encodeURIComponent(here)}`}>
            Sign in or create an account
          </Link>
        </p>
      </>
    ),
    trial_ended: (
      <>
        <p>Your free month has ended. A yearly licence keeps {PRO} unlocked on the website and the Android app.</p>
        {buy}
      </>
    ),
    license_ended: (
      <>
        <p>Your licence has ended. Renew it to keep using the Pro tools.</p>
        {buy}
      </>
    ),
    verify_email: <p>Confirm your email address first: open the link we sent when you signed up, then try again.</p>,
    error: <p>We could not check your access. Check your connection and try again.</p>,
  };
  return (
    <Modal open onClose={onClose} title={`${FEATURE_NAMES[feature]} is a Pro tool`}>
      {body[why]}
      <p className="muted">Every other tool stays free, with no account needed.</p>
    </Modal>
  );
}
