// Office conversions (PDF → Word/Excel/PowerPoint, and Word/Excel/PowerPoint → PDF). These need LibreOffice and
// layout analysis, so unlike the other tools they run on the server: the file is forwarded to the private converter
// service, the result is returned in the same response, and nothing is stored. Signed-in, verified users only, with
// per-user limits. File names and contents are never logged.
import { DomainError, type UserPrincipal } from './kernel';

export type ConvertTarget = 'docx' | 'xlsx' | 'pptx' | 'pdf';

export const OFFICE_SOURCES = ['docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'pptx', 'ppt', 'odp'] as const;

export const TARGETS: Record<ConvertTarget, { from: readonly string[]; mime: string }> = {
  docx: { from: ['pdf'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { from: ['pdf'], mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { from: ['pdf'], mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  pdf: { from: OFFICE_SOURCES, mime: 'application/pdf' },
};

export const isTarget = (t: string): t is ConvertTarget => Object.hasOwn(TARGETS, t);

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);

/** The first bytes must match the type the file name claims (the converter checks again). */
export function matchesType(ext: string, b: Uint8Array): boolean {
  if (ext === 'pdf') return new TextDecoder('latin1').decode(b.subarray(0, 1024)).includes('%PDF-');
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(ext)) return startsWith(b, ZIP);
  if (['doc', 'xls', 'ppt'].includes(ext)) return startsWith(b, OLE);
  if (ext === 'rtf') return new TextDecoder('latin1').decode(b.subarray(0, 5)) === '{\\rtf';
  return false;
}

export const extOf = (name: string) => /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** A safe download name: the original base name with the new extension. */
export function outputName(name: string, target: ConvertTarget): string {
  const base =
    name
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[\u0000-\u001f\u007f"\\/<>:|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'document';
  return `${base}.${target}`;
}

export interface Converter {
  /** Returns the converted bytes, or throws a DomainError. */
  convert(target: ConvertTarget, from: string, bytes: Uint8Array): Promise<Uint8Array>;
}

/** Talks to the converter service (`converter/`). */
export class HttpConverter implements Converter {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  constructor(opts: { url: string; token: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.#url = opts.url;
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 180_000;
  }

  async convert(target: ConvertTarget, from: string, bytes: Uint8Array): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#url}/v1/convert/${target}?from=${encodeURIComponent(from)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/octet-stream' },
        body: bytes as BodyInit,
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      // Operators need the reason (DNS, refused, timeout…); only the host and error codes are logged, never the
      // token or anything about the file.
      const err = e as Error & { cause?: { code?: string } };
      console.error(JSON.stringify({ level: 'error', msg: 'converter unreachable', host: new URL(this.#url).host, error: err?.name, code: err?.cause?.code }));
      throw new DomainError('unavailable', 'The converter is not reachable right now. Try again in a few minutes.');
    }
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    const j = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    // Only the converter's own fixed, user-facing messages are passed on, and only for problems with the file.
    const msg = typeof j?.message === 'string' ? j.message.slice(0, 300) : undefined;
    if (res.status === 422 && msg) throw new DomainError('unprocessable', msg);
    if (res.status === 413) throw new DomainError('too_large', msg ?? 'This file is too large to convert.');
    if (res.status === 400) throw new DomainError('invalid_request', 'This file does not match its type.');
    if (res.status === 429) throw new DomainError('unavailable', 'The converter is busy. Try again in a minute.');
    if (res.status === 504) throw new DomainError('unprocessable', 'This file took too long to convert. Try a smaller file.');
    throw new DomainError('unavailable', 'The file could not be converted right now. Try again later.');
  }
}

export interface ConversionLimits {
  maxBytes: number;
  perMinute: number;
  perDay: number;
}
export const DEFAULT_CONVERSION_LIMITS: ConversionLimits = { maxBytes: 50 * 1024 * 1024, perMinute: 6, perDay: 100 };

export class ConversionService {
  readonly #converter: Converter | undefined;
  readonly #hit: (key: string, limit: number, windowSeconds: number) => Promise<boolean>;
  readonly limits: ConversionLimits;
  constructor(opts: {
    converter: Converter | undefined;
    hit: (key: string, limit: number, windowSeconds: number) => Promise<boolean>;
    limits?: Partial<ConversionLimits>;
  }) {
    this.#converter = opts.converter;
    this.#hit = opts.hit;
    this.limits = { ...DEFAULT_CONVERSION_LIMITS, ...opts.limits };
  }

  get enabled() {
    return !!this.#converter;
  }

  /** Checks everything that can be checked before the body is read. */
  async admit(p: UserPrincipal, target: string, fileName: string, declaredBytes: number | undefined): Promise<{ target: ConvertTarget; from: string }> {
    if (!this.#converter) throw new DomainError('unavailable', 'Office conversion is not switched on yet.');
    if (!p.emailVerified) throw new DomainError('forbidden', 'Confirm your email address to convert files.');
    if (!isTarget(target)) throw new DomainError('not_found', 'not found');
    const from = extOf(fileName);
    if (!TARGETS[target].from.includes(from)) throw new DomainError('invalid_request', 'This file type cannot be converted this way.');
    if (declaredBytes !== undefined && declaredBytes > this.limits.maxBytes) throw this.#tooLarge();
    // Both windows are counted on every attempt, so a burst cannot dodge the daily cap.
    const minute = await this.#hit(`convert:m:${p.userId}`, this.limits.perMinute, 60);
    const day = await this.#hit(`convert:d:${p.userId}`, this.limits.perDay, 86_400);
    if (!minute) throw new DomainError('rate_limited', 'You are converting a lot of files. Wait a minute and try again.');
    if (!day) throw new DomainError('rate_limited', `You have reached today's limit of ${this.limits.perDay} conversions. Try again tomorrow.`);
    return { target, from };
  }

  async convert(job: { target: ConvertTarget; from: string }, fileName: string, bytes: Uint8Array) {
    if (!bytes.length) throw new DomainError('invalid_request', 'The file is empty.');
    if (bytes.length > this.limits.maxBytes) throw this.#tooLarge();
    if (!matchesType(job.from, bytes)) throw new DomainError('invalid_request', 'This file does not match its type.');
    const out = await this.#converter!.convert(job.target, job.from, bytes);
    return { bytes: out, name: outputName(fileName, job.target), mime: TARGETS[job.target].mime };
  }

  #tooLarge() {
    return new DomainError('too_large', `Files up to ${Math.round(this.limits.maxBytes / 1024 / 1024)} MB can be converted.`);
  }
}

/** Reads a request body without ever holding more than `max` bytes. */
export async function readBody(req: Request, max: number, tooLarge: () => Error): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** RFC 6266 attachment header with an ASCII fallback and the UTF-8 name. */
export function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
