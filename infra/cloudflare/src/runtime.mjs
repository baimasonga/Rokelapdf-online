// Pass app settings explicitly, never arbitrary deployment credentials.
const keys = [
  'TRIAL_MODE',
  'DATABASE_URL',
  'DATABASE_CA_PEM',
  'DB_SCHEMA',
  'DB_POOL_MAX',
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'PUBLIC_ORIGIN',
  'SHORT_ORIGIN',
  'SHARING_SECRET',
  'STORAGE',
  'R2_ENDPOINT',
  'R2_REGION',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'AUTH_EMAIL_HOOK_SECRET',
  'MAIL_PROVIDER',
  'MAIL_FROM',
  'CLOUDFLARE_ACCOUNT_ID',
  'RESEND_API_KEY',
  'JOB_INTERVAL_SECONDS',
  'MAINTENANCE_INTERVAL_SECONDS',
  'EVENT_RETENTION_DAYS',
  'RATE_LIMIT_PER_MINUTE',
  'BLOCKED_HOSTS',
];

export function runtimeEnvironment(bindings) {
  const env = { NODE_ENV: 'production', APP_ENV: 'production', HOSTNAME: '0.0.0.0', PORT: '3000', TRUST_PROXY: '1', NEXT_TELEMETRY_DISABLED: '1' };
  for (const key of keys) if (typeof bindings[key] === 'string') env[key] = bindings[key];
  // Separate the email token from the Wrangler deployment token.
  if (typeof bindings.MAIL_API_TOKEN === 'string') env.CLOUDFLARE_EMAIL_API_TOKEN = bindings.MAIL_API_TOKEN;
  return env;
}

// Classify errors without logging messages, URLs, request bodies or credentials.
export function containerFailure(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const name = ['Error', 'TypeError', 'RangeError', 'TimeoutError', 'AbortError', 'ContainerStartError'].includes(error?.name) ? error.name : 'UnknownError';
  let category = 'unknown';
  if (/memory|\boom\b/i.test(message)) category = 'memory';
  else if (/timeout|timed out/i.test(message)) category = 'timeout';
  else if (/exited|exit code/i.test(message)) category = 'container_exit';
  else if (/capacity|quota/i.test(message)) category = 'capacity';
  else if (/port|connection refused/i.test(message)) category = 'app_port';
  return { error_type: name, category };
}

export function containerRequest(request, canonicalOrigin) {
  const canonical = new URL(canonicalOrigin);
  if (canonical.protocol !== 'https:' || canonical.username || canonical.password || canonical.pathname !== '/' || canonical.search || canonical.hash)
    throw new Error('invalid canonical origin');
  const incoming = new URL(request.url);
  canonical.pathname = incoming.pathname;
  canonical.search = incoming.search;
  const forwarded = new Request(canonical, request);
  forwarded.headers.set('host', canonical.host);
  forwarded.headers.set('x-forwarded-host', canonical.host);
  forwarded.headers.set('x-forwarded-proto', 'https');
  forwarded.headers.delete('x-forwarded-for');
  forwarded.headers.delete('x-real-ip');
  forwarded.headers.delete('forwarded');
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) forwarded.headers.set('x-forwarded-for', ip);
  return forwarded;
}
