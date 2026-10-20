import { COMPANY } from '../company';

const mailText = (text: string) => `${text}\n\n${COMPANY.copyright}\n${COMPANY.location}\n${COMPANY.email}`;

// Email delivery through Resend or Cloudflare HTTP APIs (no SDK). Used only by the background job worker, never inline in a
// request, so a slow or failing provider cannot hold up the app. The API key is never logged.

export interface OutgoingMail {
  /** Job id for provider idempotency where supported, otherwise correlation. */
  id: string;
  to: string;
  subject: string;
  text: string;
  html?: string | undefined;
  replyTo?: string | undefined;
}

export interface Mailer {
  send(m: OutgoingMail): Promise<unknown>;
}

export class ResendMailer implements Mailer {
  readonly #key: string;
  readonly #from: string;
  readonly #fetch: typeof fetch;
  constructor(opts: { apiKey: string; from: string; fetch?: typeof fetch }) {
    this.#key = opts.apiKey;
    this.#from = opts.from;
    this.#fetch = opts.fetch ?? fetch;
  }

  async send(m: OutgoingMail) {
    const res = await this.#fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json', 'idempotency-key': m.id },
      body: JSON.stringify({
        from: this.#from,
        to: [m.to],
        subject: m.subject,
        text: mailText(m.text),
        ...(m.html ? { html: m.html } : {}),
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // The response body is not echoed: it can contain the recipient address.
    if (!res.ok) throw new Error(`email provider responded ${res.status}`);
    return undefined;
  }
}

/** Cloudflare Email Sending REST API. Existing background jobs handle transient retries.
 * Cloudflare does not document an idempotency key; an ambiguous network timeout may cause duplicate mail on retry.
 */
export class CloudflareMailer implements Mailer {
  readonly #token: string;
  readonly #accountId: string;
  readonly #timeoutMs: number;
  readonly #from: string;
  readonly #fetch: typeof fetch;
  constructor(opts: { apiToken: string; accountId: string; from: string; timeoutMs?: number; fetch?: typeof fetch }) {
    if (!/^[a-f0-9]{32}$/i.test(opts.accountId)) throw new Error('invalid Cloudflare account ID');
    this.#token = opts.apiToken;
    this.#accountId = opts.accountId;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#from = opts.from;
    this.#fetch = opts.fetch ?? fetch;
  }
  async send(m: OutgoingMail) {
    const named = /^(.*?)<([^<>]+)>$/.exec(this.#from);
    const from = named ? { address: named[2]!.trim(), name: named[1]!.trim() } : this.#from;
    const res = await this.#fetch(`https://api.cloudflare.com/client/v4/accounts/${this.#accountId}/email/sending/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: m.to,
        subject: m.subject,
        text: mailText(m.text),
        ...(m.html ? { html: m.html } : {}),
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
        headers: { 'X-Rokela-Job-ID': m.id },
      }),
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: 'error',
    });
    if (!res.ok) throw Object.assign(new Error(`Cloudflare email provider responded ${res.status}`), { code: `cloudflare_email_http_${res.status}` });
    // Never echo response bodies: they can contain recipient addresses and provider details.
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      result?: { delivered?: string[]; queued?: string[]; permanent_bounces?: string[]; suppressed_recipients?: string[] };
    } | null;
    const contains = (list: unknown) => Array.isArray(list) && list.some((v) => typeof v === 'string' && v.toLowerCase() === m.to.toLowerCase());
    if (
      !body?.success ||
      contains(body.result?.permanent_bounces) ||
      contains(body.result?.suppressed_recipients) ||
      !(contains(body.result?.delivered) || contains(body.result?.queued))
    )
      throw Object.assign(new Error('Cloudflare email provider did not accept the recipient'), { code: 'cloudflare_email_not_accepted' });
  }
}
