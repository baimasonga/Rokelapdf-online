import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

afterEach(() => vi.unstubAllEnvs());
describe('canonical account domain', () => {
  const setup = () => {
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('PUBLIC_ORIGIN', 'https://www.rokelapdf.com');
  };
  it('moves account requests to the canonical origin and preserves the recovery path', () => {
    setup();
    const response = proxy(new NextRequest('https://rokela.up.railway.app/signin?mode=forgot&next=%2Fapp'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://www.rokelapdf.com/signin?mode=forgot&next=%2Fapp');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('does not loop on the canonical origin or redirect custom sharing domains', () => {
    setup();
    expect(proxy(new NextRequest('https://www.rokelapdf.com/signin')).headers.get('location')).toBeNull();
    expect(proxy(new NextRequest('https://customer.example/shared-file')).headers.get('location')).toBeNull();
  });
  it('keeps local development on its own origin', () => {
    setup();
    vi.stubEnv('APP_ENV', 'development');
    expect(proxy(new NextRequest('http://127.0.0.1:3000/signin')).headers.get('location')).toBeNull();
  });
});
