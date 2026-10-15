import { describe, expect, it } from 'vitest';
import { connectionConfig } from '@/lib/server/db/connect';

describe('database connection settings', () => {
  it('uses verified TLS with the given CA and drops URL TLS parameters that would override it', () => {
    const c = connectionConfig('postgresql://app:pw@db.example:5432/postgres?sslmode=require&application_name=rokela', 'PEM');
    expect(c.ssl).toEqual({ ca: 'PEM', rejectUnauthorized: true });
    expect(c.connectionString).toBe('postgresql://app:pw@db.example:5432/postgres?application_name=rokela');
  });
  it('leaves the URL alone without a CA', () => {
    expect(connectionConfig('postgresql://a@b/c?sslmode=require', undefined)).toEqual({ connectionString: 'postgresql://a@b/c?sslmode=require' });
  });
});
