// Email delivery through Resend's HTTP API (no SDK). Used only by the background job worker, never inline in a
// request, so a slow or failing provider cannot hold up the app. The API key is never logged.

export interface OutgoingMail {
  /** Job id; sent as the idempotency key so a retried job does not send the same email twice. */
  id: string;
  to: string;
  subject: string;
  text: string;
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
      body: JSON.stringify({ from: this.#from, to: [m.to], subject: m.subject, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    // The response body is not echoed: it can contain the recipient address.
    if (!res.ok) throw new Error(`email provider responded ${res.status}`);
    return undefined;
  }
}
