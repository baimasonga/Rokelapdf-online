// Content-Security-Policy for HTML pages. Scripts run only with a per-request nonce ('strict-dynamic' lets Next's
// nonce-bearing loader pull in its chunks); the browser may talk only to this origin, Supabase Auth and the private
// object store that serves signed URLs. No inline event handlers, no plugins, no framing, no base-tag hijacking.

export interface CspInputs {
  nonce: string;
  /** `next dev` (hot reload needs eval and websockets). Never true for a production build. */
  devServer: boolean;
  /** The app is served over HTTPS: upgrade stray http:// requests. */
  https: boolean;
  supabaseUrl: string | undefined;
  storageOrigin: string | undefined;
}

const originOf = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
};

export function buildCsp(i: CspInputs): string {
  const connect = ["'self'", originOf(i.supabaseUrl), originOf(i.storageOrigin), ...(i.devServer ? ['ws:'] : [])].filter(Boolean);
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", `'nonce-${i.nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'", ...(i.devServer ? ["'unsafe-eval'"] : [])]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'blob:', 'data:']],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', connect as string[]],
    ['worker-src', ["'self'", 'blob:']],
    ['frame-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  const out = directives.map(([k, v]) => `${k} ${v.join(' ')}`);
  if (i.https) out.push('upgrade-insecure-requests');
  return out.join('; ');
}

/** CSP inputs from the same environment variables the server reads (see config.ts). */
export function cspInputsFromEnv(env: Record<string, string | undefined>, nonce: string): CspInputs {
  const appEnv = env['APP_ENV'] ?? env['NODE_ENV'] ?? 'development';
  const local = env['STORAGE'] === 'local' || (!env['STORAGE'] && appEnv !== 'production');
  return {
    nonce,
    devServer: env['NODE_ENV'] === 'development',
    https: (env['PUBLIC_ORIGIN'] ?? '').startsWith('https:'),
    supabaseUrl: env['SUPABASE_URL'] ?? (appEnv !== 'production' ? 'http://127.0.0.1:54321' : undefined),
    storageOrigin: local ? (env['CONTENT_ORIGIN'] ?? `http://127.0.0.1:${env['CONTENT_PORT'] ?? 3001}`) : env['R2_ENDPOINT'],
  };
}

/** Headers set on every HTML page in addition to the CSP. */
export function pageSecurityHeaders(https: boolean): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    ...(https ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}
