import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DomainError } from '@/lib/server/kernel';
import { Router } from '@/lib/server/api/router';
import type { Container } from '@/lib/server/container';

// A DomainError created by another bundled copy of kernel.ts (Next bundles instrumentation and routes separately).
const foreign = (code: string, status: number, message: string) =>
  Object.assign(new Error(message), { name: 'DomainError', code, status, details: undefined, [Symbol.for('rokela.DomainError')]: true });

const stub = { config: { trustProxy: 0, rateLimitPerMinute: 1000 }, rateLimiter: { hit: async () => true } } as unknown as Container;
const call = async (r: Router) => {
  const res = await r.handle(stub, new Request('http://x/t', { method: 'GET' }));
  return { status: res.status, body: await res.json() };
};

describe('errors across bundle copies', () => {
  it('recognizes domain errors from another copy of the class, and nothing else', () => {
    expect(foreign('not_found', 404, 'x') instanceof DomainError).toBe(true);
    expect(new DomainError('conflict', 'x') instanceof DomainError).toBe(true);
    expect(Object.assign(new Error('x'), { name: 'DomainError', code: 'not_found' }) instanceof DomainError).toBe(false);
    expect((null as unknown as object) instanceof DomainError).toBe(false);
  });

  it('the router maps a foreign domain error to its status instead of a 500', async () => {
    const r = new Router().add('GET', '/t', 'public', async () => {
      throw foreign('link_unavailable', 410, 'gone');
    });
    expect(await call(r)).toMatchObject({ status: 410, body: { code: 'link_unavailable', message: 'gone' } });
  });

  it('the router maps a validation error to 400 without echoing input', async () => {
    const r = new Router().add('GET', '/t', 'public', async () => z.object({ a: z.string() }).strict().parse({ a: 1, secret: 'hunter2' }));
    const out = await call(r);
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).not.toContain('hunter2');
  });

  it('unknown errors stay a generic 500', async () => {
    const r = new Router().add('GET', '/t', 'public', async () => {
      throw new Error('database password is xyz');
    });
    const out = await call(r);
    expect(out).toMatchObject({ status: 500, body: { code: 'internal', message: 'internal error' } });
  });
});
