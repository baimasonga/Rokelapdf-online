import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { COMPANY } from '../company';
import { CloudflareMailer, type Mailer, type OutgoingMail } from './mail';

const email = z.string().email().max(320);
const payload = z.object({
  user: z.object({ email, new_email: email.optional() }),
  email_data: z.object({
    email_action_type: z.enum(['signup', 'recovery', 'invite', 'magiclink', 'reauthentication', 'email_change']),
    token: z.string().max(256).optional(),
    token_new: z.string().max(256).optional(),
    token_hash: z.string().max(256).optional(),
    token_hash_new: z.string().max(256).optional(),
    redirect_to: z.string().max(4096).optional(),
  }),
});
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export interface AuthEmailOptions {
  secret: string;
  supabaseUrl: string;
  publicOrigin: string;
  mailer: Mailer;
}

function origin(s: string) {
  const u = new URL(s);
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('invalid origin');
  return u.origin;
}

export function authEmailOptions(env: Readonly<Record<string, string | undefined>> = process.env): AuthEmailOptions | undefined {
  if (!env.AUTH_EMAIL_HOOK_SECRET) return undefined;
  if (env.MAIL_PROVIDER !== 'cloudflare' || !env.CLOUDFLARE_EMAIL_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID || !env.MAIL_FROM)
    throw Error('Cloudflare auth email configuration incomplete');
  if (!/^(?:[^<>\r\n]+\s*<)?[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>?$/.test(env.MAIL_FROM)) throw Error('invalid auth email sender');
  const secret = env.AUTH_EMAIL_HOOK_SECRET;
  if (!/^v1,whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || Buffer.from(secret.slice(9), 'base64').length < 32) throw Error('invalid auth email signing secret');
  return {
    secret,
    supabaseUrl: origin(env.SUPABASE_URL ?? ''),
    publicOrigin: origin(env.PUBLIC_ORIGIN ?? ''),
    mailer: new CloudflareMailer({ apiToken: env.CLOUDFLARE_EMAIL_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID, from: env.MAIL_FROM, timeoutMs: 3000 }),
  };
}

function render(origin: string, heading: string, instruction: string, action: string, url?: string) {
  const e = escape;
  const actionHtml = url
    ? `<a href="${e(url)}" style="display:inline-block;padding:16px 24px;background:#123c78;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">${e(action)}</a>`
    : `<p style="font-size:30px;font-weight:bold;letter-spacing:5px;color:#0c3064">${e(action)}</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(heading)}</title></head><body style="margin:0;background:#f0f5fb;font-family:Arial,Helvetica,sans-serif;color:#101f38"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:28px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:16px"><tr><td style="padding:26px;background:#082451;border-bottom:5px solid #ff6759;border-radius:16px 16px 0 0"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td width="76"><img src="${e(origin)}/brand/rokela-icon.png" alt="Rokela logo" width="60" height="60" style="display:block;border:0"></td><td style="color:#fff;font-size:28px;font-weight:bold">Rokela <span style="color:#ff9185">PDF</span><p style="margin:5px 0 0;font-size:13px;font-weight:normal;color:#dce7f4">By ${e(COMPANY.name)}</p></td></tr></table></td></tr><tr><td style="padding:30px 26px"><h1 style="margin:0 0 18px;font-size:26px;color:#0c3064">${e(heading)}</h1><p style="font-size:16px;line-height:26px;color:#334155">${e(instruction)}</p>${actionHtml}<p style="font-size:14px;line-height:23px;color:#64748b">Open links in the browser where you started the request. Keep this email and its links or codes private. If you did not request this, do not use the link or code.</p></td></tr><tr><td style="padding:24px 26px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:20px;color:#64748b">${e(COMPANY.copyright)}<br>Rokela PDF is owned and operated by ${e(COMPANY.name)}, ${e(COMPANY.location)}. Its original software, interface, content and branding are proprietary to ${e(COMPANY.name)}. Third-party materials retain their respective licenses. Your files remain yours.<br><a href="mailto:${e(COMPANY.email)}" style="color:#123c78">${e(COMPANY.email)}</a><br><a href="${e(origin)}/ownership" style="color:#123c78">Ownership</a> · <a href="${e(origin)}/privacy" style="color:#123c78">Privacy</a> · <a href="${e(origin)}/terms" style="color:#123c78">Terms</a></td></tr></table></td></tr></table></body></html>`;
}

export function authEmailMessages(value: unknown, options: Pick<AuthEmailOptions, 'supabaseUrl' | 'publicOrigin'>, id: string): OutgoingMail[] {
  const { user, email_data: d } = payload.parse(value);
  const publicOrigin = origin(options.publicOrigin),
    supabaseOrigin = origin(options.supabaseUrl);
  const redirect = new URL(d.redirect_to || publicOrigin);
  if (redirect.origin !== publicOrigin || redirect.username || redirect.password) throw Error('invalid redirect');
  const action = d.email_action_type;
  const headings = {
    signup: 'Confirm your email address',
    recovery: 'Reset your password',
    invite: 'You’re invited to Rokela PDF',
    magiclink: 'Sign in to Rokela PDF',
    reauthentication: 'Verify your identity',
    email_change: 'Confirm your email change',
  };
  const heading = headings[action];
  function message(to: string, hash: string | undefined, code: string | undefined, suffix: string): OutgoingMail {
    let url: string | undefined;
    if (action === 'reauthentication') {
      if (!code || !/^\d{4,12}$/.test(code)) throw Error('invalid code');
    } else {
      if (!hash || !/^[A-Za-z0-9_-]{20,256}$/.test(hash)) throw Error('invalid token hash');
      const link = new URL('/auth/v1/verify', supabaseOrigin);
      link.searchParams.set('token', hash);
      link.searchParams.set('type', action);
      link.searchParams.set('redirect_to', redirect.href);
      url = link.href;
    }
    const label = action === 'reauthentication' ? code! : heading;
    const instruction =
      action === 'signup'
        ? 'Welcome to Rokela PDF. Confirm your email address to finish creating your account.'
        : `Use this ${url ? 'link' : 'code'} to complete your Rokela PDF request.`;
    return {
      id: `auth_${id}_${suffix}`,
      to,
      subject: `${heading} · Rokela PDF`,
      text: `${instruction}\n\n${url ?? code}\n\nKeep this link or code private. If you did not request this, do not use it.\nRokela PDF is owned and operated by ${COMPANY.name}. Your files remain yours.`,
      html: render(publicOrigin, heading, instruction, label, url),
    };
  }
  if (action === 'email_change') {
    if (!user.new_email) throw Error('new email missing');
    const messages = [message(user.new_email, d.token_hash, d.token_new || d.token, 'new')];
    if (d.token_hash_new) messages.unshift(message(user.email, d.token_hash_new, d.token, 'current'));
    return messages;
  }
  return [message(user.email, d.token_hash, d.token, 'primary')];
}

const response = (status: number, message?: string) =>
  Response.json(message ? { error: { http_code: status, message } } : {}, { status, headers: { 'cache-control': 'no-store' } });
export async function handleAuthEmail(req: Request, options?: AuthEmailOptions): Promise<Response> {
  if (!options) return response(404, 'Not found');
  if (req.method !== 'POST') return response(405, 'Method not allowed');
  let raw = '';
  try {
    if (Number(req.headers.get('content-length')) > 65536) return response(413, 'Request too large');
    const reader = req.body?.getReader();
    if (!reader) return response(400, 'Invalid request');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 65536) {
          await reader.cancel();
          return response(413, 'Request too large');
        }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } catch {
    return response(400, 'Invalid request');
  }
  let verified: unknown;
  try {
    verified = new Webhook(options.secret.replace(/^v1,whsec_/, '')).verify(raw, Object.fromEntries(req.headers));
  } catch {
    return response(401, 'Invalid hook signature');
  }
  let messages: OutgoingMail[];
  try {
    const id = req.headers.get('webhook-id')!;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw Error('invalid id');
    messages = authEmailMessages(verified, options, id);
  } catch {
    return response(400, 'Unsupported or invalid auth email');
  }
  try {
    await Promise.all(messages.map((m) => options.mailer.send(m)));
    return response(200);
  } catch {
    return response(503, 'Authentication email delivery unavailable');
  }
}
