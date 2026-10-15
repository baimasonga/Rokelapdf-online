import type { ClientConfig } from 'pg';

/**
 * Connection settings with verified TLS when the server's CA certificate is given (Supabase uses its own root CA).
 * TLS parameters in the URL are dropped in that case: pg lets URL parameters override explicit settings, so a
 * `?sslmode=require` would otherwise silently replace the verified configuration.
 */
export function connectionConfig(url: string, caPem: string | undefined): ClientConfig {
  if (!caPem) return { connectionString: url };
  const u = new URL(url);
  for (const p of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey']) u.searchParams.delete(p);
  return { connectionString: u.toString(), ssl: { ca: caPem, rejectUnauthorized: true } };
}
