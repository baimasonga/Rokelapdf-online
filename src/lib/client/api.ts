// Browser API client. The Supabase access token is sent as a bearer token (no cookies, so no CSRF surface);
// every response is authorized by the server, the client only displays what the API returns.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let tokenProvider: () => Promise<string | undefined> = async () => undefined;
export function setTokenProvider(fn: () => Promise<string | undefined>) {
  tokenProvider = fn;
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send the session token if there is one (default true). */
  auth?: boolean;
}

const MESSAGES: Record<string, string> = {
  rate_limited: 'Too many requests. Wait a minute and try again.',
  internal: 'Something went wrong on our side. Try again.',
};

async function send(path: string, o: ApiOptions): Promise<Response> {
  const token = o.auth === false ? undefined : await tokenProvider();
  return fetch(path, {
    method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'),
    credentials: 'omit',
    headers: {
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...o.headers,
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
}

async function fail(res: Response): Promise<never> {
  const j = (await res.json().catch(() => null)) as { code?: string; message?: string; details?: Record<string, unknown> } | null;
  throw new ApiError((j?.code && MESSAGES[j.code]) || j?.message || 'The request could not be completed.', res.status, j?.code, j?.details);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(path: string, o: ApiOptions = {}): Promise<T> {
  const res = await send(path, o);
  if (!res.ok) return fail(res);
  return (res.status === 204 ? null : await res.json()) as T;
}

export async function apiBlob(path: string, o: ApiOptions = {}): Promise<Blob> {
  const res = await send(path, o);
  if (!res.ok) return fail(res);
  return res.blob();
}

/** Downloads bytes from a short-lived signed storage URL (separate origin, never with credentials). */
export async function fetchSigned(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new ApiError('The file could not be downloaded.', res.status);
  return new Uint8Array(await res.arrayBuffer());
}

export const enc = encodeURIComponent;
export const sharingPath = (orgId: string) => `/api/v1/workspaces/${enc(orgId)}/sharing`;

/** Uploads a file as the raw request body (signed in) and returns the response file. */
export async function apiSendFile(path: string, file: Blob): Promise<Blob> {
  const token = await tokenProvider();
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: file,
  });
  if (!res.ok) return fail(res);
  return res.blob();
}
