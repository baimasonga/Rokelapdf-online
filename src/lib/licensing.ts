// Which tools are paid, and how one person's access to them is decided. Shared by the server, the website and the
// Android app (through the @/ alias), so all three agree.
//
// A licence is per person, tied to their email, and lasts a year (operators grant it; see docs/licensing.md). Every
// account also gets a free month of the paid tools from its first sign-in. Before the launch date
// (PAID_FEATURES_FROM) the paid tools are free for everyone, signed in or not.

export const PAID_FEATURES = ['edit', 'sign', 'ocr', 'protect', 'split', 'merge'] as const;
export type PaidFeature = (typeof PAID_FEATURES)[number];

/** How each paid feature is named to people ("Editing is part of Rokela PDF Pro"). */
export const FEATURE_NAMES: Record<PaidFeature, string> = {
  edit: 'Editing',
  sign: 'Signing',
  ocr: 'Text recognition (OCR)',
  protect: 'Password protection',
  split: 'Splitting',
  merge: 'Merging',
};

export const TRIAL_DAYS = 30;
const DAY_MS = 86_400_000;

/** The website's tool pages that are paid, by slug. Every other tool stays free. */
export const PAID_TOOLS: Readonly<Record<string, PaidFeature>> = {
  'edit-pdf': 'edit',
  'highlight-pdf': 'edit',
  'annotate-pdf': 'edit',
  'redact-pdf': 'edit',
  'watermark-pdf': 'edit',
  'page-numbers': 'edit',
  'sign-pdf': 'sign',
  'ocr-pdf': 'ocr',
  'protect-pdf': 'protect',
  'split-pdf': 'split',
  'extract-pages': 'split',
  'merge-pdf': 'merge',
};

/**
 * - `open`: the paid tools are free for everyone (before the launch date); `until` is that date, if one is set.
 * - `license` / `trial`: this person may use them until `until`.
 * - `none`: they may not; `reason` says why, so the prompt can say what to do.
 */
export type AccessKind = 'open' | 'license' | 'trial' | 'none';
export interface Access {
  access: AccessKind;
  until: string | null;
  reason?: 'trial_ended' | 'license_ended' | 'verify_email';
}

/** Whether an answer from the server (possibly cached) still allows the paid tools at `now`. */
export function canUsePaid(a: Access | undefined, now = new Date()): boolean {
  if (!a || a.access === 'none') return false;
  // `open` without a date stays open; any other answer lapses at its date.
  return a.access === 'open' && !a.until ? true : !!a.until && new Date(a.until) > now;
}

/**
 * One person's access to the paid tools. A licence is honoured only for a confirmed email: it is tied to the address,
 * and an unconfirmed sign-up must not borrow someone else's. The free month starts at the person's first sign-in, or
 * at launch for people who signed in before it.
 */
export function resolveAccess(o: {
  now: Date;
  paidFrom: Date | undefined;
  firstSeen: Date;
  emailVerified: boolean;
  license: { from: Date; until: Date } | undefined;
}): Access {
  const { now, paidFrom, license } = o;
  if (!paidFrom || now < paidFrom) return { access: 'open', until: paidFrom ? paidFrom.toISOString() : null };
  if (!o.emailVerified) return { access: 'none', until: null, reason: 'verify_email' };
  if (license && license.from <= now && now < license.until) return { access: 'license', until: license.until.toISOString() };
  const trialEnd = new Date(Math.max(o.firstSeen.getTime(), paidFrom.getTime()) + TRIAL_DAYS * DAY_MS);
  if (now < trialEnd) return { access: 'trial', until: trialEnd.toISOString() };
  return { access: 'none', until: null, reason: license && license.until <= now ? 'license_ended' : 'trial_ended' };
}
