import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

const saved = { ...process.env };
beforeEach(() => {
  process.env['APP_ENV'] = 'production';
  process.env['PUBLIC_ORIGIN'] = 'https://www.example.test';
});
afterEach(() => {
  process.env = { ...saved };
});

// Behind Railway and Cloudflare the app is reached over plain HTTP on an internal port; only the headers carry the
// public host. A request URL like this one is what the proxy actually sees in production.
const signin = (headers: Record<string, string>) => proxy(new NextRequest('http://localhost:8080/signin?next=%2Fapp', { headers }));

describe('sign-in canonical host', () => {
  it('serves the sign-in page on the canonical host instead of redirecting it to itself', () => {
    expect(signin({ host: 'www.example.test', 'x-forwarded-proto': 'https' }).headers.get('location')).toBeNull();
    expect(signin({ host: 'localhost:8080', 'x-forwarded-host': 'www.example.test' }).headers.get('location')).toBeNull();
  });

  it('sends other hosts to the canonical sign-in page once, keeping the query', () => {
    for (const host of ['example.test', 'rokela.workers.dev', 'go.custom-domain.test']) {
      const res = signin({ host });
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://www.example.test/signin?next=%2Fapp');
    }
  });
});
