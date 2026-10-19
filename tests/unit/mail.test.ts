import { describe, expect, it } from 'vitest';
import { CloudflareMailer, ResendMailer } from '@/lib/server/mail';

describe('Resend mailer', () => {
  it('sends with the job id as idempotency key and never echoes the provider response or key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let status = 200;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"error":"recipient a@b.co is blocked"}', { status });
    }) as unknown as typeof fetch;
    const m = new ResendMailer({ apiKey: 're_secret_key', from: 'Rokela <t@rokela.example>', fetch: fake });
    await m.send({ id: 'job_1', to: 'a@b.co', subject: 'Hi', text: 'Body', html: '<p>Body</p>', replyTo: 's@x.co' });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['idempotency-key']).toBe('job_1');
    expect(h['authorization']).toBe('Bearer re_secret_key');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: 'Rokela <t@rokela.example>',
      to: ['a@b.co'],
      subject: 'Hi',
      text: expect.stringContaining('Quantix Sierra Leone'),
      html: '<p>Body</p>',
      reply_to: 's@x.co',
    });
    status = 422;
    const err = await m.send({ id: 'job_2', to: 'a@b.co', subject: 'Hi', text: 'Body' }).catch((e: Error) => e);
    expect(String(err)).toBe('Error: email provider responded 422');
  });
});

describe('Cloudflare mailer', () => {
  it('uses the documented REST payload, preserves sender/reply-to, and accepts queued or delivered recipients', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let result = { delivered: [] as string[], queued: ['a@b.co'] };
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ success: true, result });
    }) as unknown as typeof fetch;
    const mailer = new CloudflareMailer({ accountId: 'a'.repeat(32), apiToken: 'cf-secret', from: 'Rokela PDF <transfers@rokela.example>', fetch: fake });
    const message = { id: 'job_1', to: 'a@b.co', subject: 'Download files', text: 'Your private link', html: '<p>Download</p>', replyTo: 'sender@x.co' };
    await mailer.send(message);
    expect(calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/email/sending/send`);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer cf-secret');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: { address: 'transfers@rokela.example', name: 'Rokela PDF' },
      to: 'a@b.co',
      subject: 'Download files',
      text: expect.stringContaining('contact@quantixsl.com'),
      html: '<p>Download</p>',
      reply_to: 'sender@x.co',
      headers: { 'X-Rokela-Job-ID': 'job_1' },
    });
    result = { delivered: ['A@B.CO'], queued: [] };
    await expect(mailer.send(message)).resolves.toBeUndefined();
  });
  it.each([
    { success: false, errors: [{ message: 'secret recipient a@b.co' }] },
    { success: true, result: { permanent_bounces: ['a@b.co'] } },
    { success: true, result: { suppressed_recipients: ['a@b.co'], queued: ['a@b.co'] } },
    { success: true, result: { queued: ['someone-else@b.co'] } },
    { success: true },
  ])('does not mark unsuccessful, bounced, suppressed or unacknowledged mail as accepted (%j)', async (body) => {
    const mailer = new CloudflareMailer({
      accountId: 'a'.repeat(32),
      apiToken: 'secret',
      from: 't@rokela.example',
      fetch: (async () => Response.json(body)) as typeof fetch,
    });
    await expect(mailer.send({ id: 'job', to: 'a@b.co', subject: 'Hi', text: 'Body' })).rejects.toThrow(
      'Cloudflare email provider did not accept the recipient',
    );
  });
  it('reports only HTTP status on provider errors and rejects malformed success responses', async () => {
    let status = 403;
    const mailer = new CloudflareMailer({
      accountId: 'a'.repeat(32),
      apiToken: 'secret',
      from: 't@rokela.example',
      fetch: (async () => new Response('private provider response', { status })) as typeof fetch,
    });
    await expect(mailer.send({ id: 'job', to: 'a@b.co', subject: 'Hi', text: 'Body' })).rejects.toThrow('Cloudflare email provider responded 403');
    status = 200;
    await expect(mailer.send({ id: 'job', to: 'a@b.co', subject: 'Hi', text: 'Body' })).rejects.toThrow(
      'Cloudflare email provider did not accept the recipient',
    );
  });
});
