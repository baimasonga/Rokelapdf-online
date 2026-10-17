import { describe, expect, it } from 'vitest';
import { ResendMailer } from '@/lib/server/mail';

describe('Resend mailer', () => {
  it('sends with the job id as idempotency key and never echoes the provider response or key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let status = 200;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"error":"recipient a@b.co is blocked"}', { status });
    }) as unknown as typeof fetch;
    const m = new ResendMailer({ apiKey: 're_secret_key', from: 'Rokela <t@rokela.example>', fetch: fake });
    await m.send({ id: 'job_1', to: 'a@b.co', subject: 'Hi', text: 'Body', replyTo: 's@x.co' });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['idempotency-key']).toBe('job_1');
    expect(h['authorization']).toBe('Bearer re_secret_key');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: 'Rokela <t@rokela.example>',
      to: ['a@b.co'],
      subject: 'Hi',
      text: 'Body',
      reply_to: 's@x.co',
    });
    status = 422;
    const err = await m.send({ id: 'job_2', to: 'a@b.co', subject: 'Hi', text: 'Body' }).catch((e: Error) => e);
    expect(String(err)).toBe('Error: email provider responded 422');
  });
});
