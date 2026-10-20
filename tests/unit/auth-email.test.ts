import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { authEmailMessages, authEmailOptions, handleAuthEmail, type AuthEmailOptions } from '@/lib/server/auth-email';
import { CloudflareMailer } from '@/lib/server/mail';
import { POST } from '@/app/api/auth/send-email/route';

const key = Buffer.alloc(32, 71);
const secret = `v1,whsec_${key.toString('base64')}`;
const body = {
  user: { email: 'trial@example.invalid' },
  email_data: { email_action_type: 'signup', token_hash: 'a'.repeat(64), redirect_to: 'https://pdf.example/signin?next=%2Fapp' },
};
const options = (): AuthEmailOptions => ({
  secret,
  publicOrigin: 'https://pdf.example',
  supabaseUrl: 'https://project.supabase.co',
  mailer: { send: vi.fn().mockResolvedValue(undefined) },
});
function signed(value: unknown = body, timestamp = Math.floor(Date.now() / 1000), signingKey = key) {
  const raw = JSON.stringify(value),
    id = 'msg_synthetic';
  const signature = createHmac('sha256', signingKey).update(`${id}.${timestamp}.${raw}`).digest('base64');
  return new Request('https://pdf.example/api/auth/send-email', {
    method: 'POST',
    body: raw,
    headers: { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${signature}` },
  });
}

describe('signed Cloudflare auth email hook', () => {
  it('is opt-in; an unsigned request cannot send email', async () => {
    expect((await handleAuthEmail(signed())).status).toBe(404);
    const o = options();
    expect((await handleAuthEmail(new Request('https://pdf.example', { method: 'POST', body: JSON.stringify(body) }), o)).status).toBe(401);
    expect(o.mailer.send).not.toHaveBeenCalled();
  });
  it('accepts a valid signature and renders the real logo, brand and ownership with a Supabase verify URL', async () => {
    const o = options();
    const response = await handleAuthEmail(signed(), o);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    const mail = vi.mocked(o.mailer.send).mock.calls[0]![0];
    expect(mail.to).toBe('trial@example.invalid');
    expect(mail.html).toContain('https://pdf.example/brand/rokela-icon.png');
    expect(mail.html).toContain('#082451');
    expect(mail.html).toContain('#ff6759');
    expect(mail.html).toContain('proprietary to Quantix Sierra Leone');
    expect(mail.html).toContain('contact@quantixsl.com');
    const url = new URL(mail.text.split('\n\n')[1]!);
    expect(url.origin).toBe('https://project.supabase.co');
    expect(url.pathname).toBe('/auth/v1/verify');
    expect(url.searchParams.get('token')).toBe('a'.repeat(64));
    expect(url.searchParams.get('type')).toBe('signup');
    expect(url.searchParams.get('redirect_to')).toBe(body.email_data.redirect_to);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects wrong signatures, tampering, stale and future timestamps before calling the sender', async () => {
    const o = options();
    for (const request of [
      signed(body, undefined, Buffer.alloc(32, 22)),
      signed(body, Math.floor(Date.now() / 1000) - 601),
      signed(body, Math.floor(Date.now() / 1000) + 601),
    ])
      expect((await handleAuthEmail(request, o)).status).toBe(401);
    const request = signed();
    expect(
      (
        await handleAuthEmail(
          new Request(request.url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify({ ...body, user: { email: 'attacker@example.invalid' } }),
          }),
          o,
        )
      ).status,
    ).toBe(401);
    expect(o.mailer.send).not.toHaveBeenCalled();
  });
  it('rejects oversized streamed bodies without trusting content-length', async () => {
    const o = options();
    expect((await handleAuthEmail(new Request('https://pdf.example', { method: 'POST', body: 'x'.repeat(65537) }), o)).status).toBe(413);
    expect(o.mailer.send).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.example/path', 'https://pdf.example.attacker.example', 'javascript:alert(1)', 'https://user:pass@pdf.example'])(
    'rejects unsafe redirect %s',
    async (redirect_to) => {
      const o = options();
      expect((await handleAuthEmail(signed({ ...body, email_data: { ...body.email_data, redirect_to } }), o)).status).toBe(400);
      expect(o.mailer.send).not.toHaveBeenCalled();
    },
  );
  it.each(['recovery', 'invite', 'magiclink'])('routes %s through Supabase verification', (action) => {
    const message = authEmailMessages({ ...body, email_data: { ...body.email_data, email_action_type: action } }, options(), 'test')[0]!;
    expect(new URL(message.text.split('\n\n')[1]!).searchParams.get('type')).toBe(action);
  });
  it('supports reauthentication codes without inventing a verification link', () => {
    const message = authEmailMessages({ ...body, email_data: { email_action_type: 'reauthentication', token: '123456' } }, options(), 'test')[0]!;
    expect(message.html).toContain('123456');
    expect(message.html).not.toContain('/auth/v1/verify');
  });
  it('maps both secure email change hashes to the correct addresses and supports one-sided changes', () => {
    const value = {
      user: { email: 'current@example.invalid', new_email: 'new@example.invalid' },
      email_data: { email_action_type: 'email_change', token_hash: 'n'.repeat(64), token_hash_new: 'c'.repeat(64), token: '111111', token_new: '222222' },
    };
    const mails = authEmailMessages(value, options(), 'test');
    expect(mails.map((m) => [m.to, new URL(m.text.split('\n\n')[1]!).searchParams.get('token')])).toEqual([
      ['current@example.invalid', 'c'.repeat(64)],
      ['new@example.invalid', 'n'.repeat(64)],
    ]);
    const single = authEmailMessages({ ...value, email_data: { ...value.email_data, token_hash_new: '' } }, options(), 'test');
    expect(single).toHaveLength(1);
    expect(single[0]!.to).toBe('new@example.invalid');
  });
  it('fails closed for unknown actions or invalid tokens without disclosing input', async () => {
    const o = options();
    for (const data of [{ email_action_type: 'password_changed_notification' }, { ...body.email_data, token_hash: '<script>secret</script>' }]) {
      const response = await handleAuthEmail(signed({ ...body, email_data: data }), o);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('secret');
    }
    expect(o.mailer.send).not.toHaveBeenCalled();
  });
  it('acknowledges only Cloudflare recipient acceptance and hides provider errors', async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ success: true, result: { queued: ['trial@example.invalid'] } }));
    const o = options();
    o.mailer = new CloudflareMailer({
      accountId: 'a'.repeat(32),
      apiToken: 'private-token',
      from: 'Rokela PDF <mail@example.invalid>',
      fetch: send,
      timeoutMs: 3000,
    });
    expect((await handleAuthEmail(signed(), o)).status).toBe(200);
    expect(JSON.parse(String(send.mock.calls[0]![1].body)).from.name).toBe('Rokela PDF');
    send.mockResolvedValue(Response.json({ success: true, result: { suppressed_recipients: ['trial@example.invalid'] } }));
    const response = await handleAuthEmail(signed(), o);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/trial@|private-token/);
    send.mockRejectedValue(Error('private-token and recipient'));
    expect((await handleAuthEmail(signed(), o)).status).toBe(503);
  });
  it('validates optional configuration without requiring a database or service-role key', () => {
    expect(authEmailOptions({})).toBeUndefined();
    expect(() => authEmailOptions({ AUTH_EMAIL_HOOK_SECRET: secret })).toThrow();
    const env = {
      AUTH_EMAIL_HOOK_SECRET: secret,
      MAIL_PROVIDER: 'cloudflare',
      CLOUDFLARE_EMAIL_API_TOKEN: 'private',
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      MAIL_FROM: 'Rokela PDF <mail@example.invalid>',
      SUPABASE_URL: 'https://project.supabase.co',
      PUBLIC_ORIGIN: 'https://pdf.example',
    };
    expect(authEmailOptions(env)?.publicOrigin).toBe('https://pdf.example');
    expect(() => authEmailOptions({ ...env, AUTH_EMAIL_HOOK_SECRET: 'v1,whsec_short' })).toThrow();
    expect(() => authEmailOptions({ ...env, PUBLIC_ORIGIN: 'http://pdf.example' })).toThrow();
  });
  it('the Next route is disabled by default and hides configuration failures', async () => {
    vi.stubEnv('AUTH_EMAIL_HOOK_SECRET', '');
    try {
      expect((await POST(signed())).status).toBe(404);
      vi.stubEnv('AUTH_EMAIL_HOOK_SECRET', 'bad');
      const response = await POST(signed());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('bad');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
