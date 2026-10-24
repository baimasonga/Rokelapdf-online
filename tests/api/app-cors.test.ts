import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '@/lib/server/kernel';
import type { ConvertTarget, Converter } from '@/lib/server/convert';
import { pdf, sharingEnv, type SharingEnv } from './support';

// The Android app runs at https://localhost inside its WebView. Only the configuration and conversion routes answer
// it cross-origin; no other origin and no other route ever gets CORS headers.

let env: SharingEnv;
afterEach(async () => {
  await env?.close();
});

class EchoConverter implements Converter {
  async convert(target: ConvertTarget, _from: string, bytes: Uint8Array) {
    if (bytes.length === 0) throw new DomainError('unprocessable', 'empty');
    return target === 'pdf' ? pdf('converted') : new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9]);
  }
}

const APP = 'https://localhost';
const preflight = (path: string, origin: string, method = 'POST') =>
  env.call('OPTIONS', path, { headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': 'authorization, content-type' } });

describe('app CORS: preflight', () => {
  it('allows the app origin on the conversion and configuration routes', async () => {
    env = await sharingEnv({ converter: new EchoConverter() });
    const r = await preflight('/api/v1/convert/pdf?name=a.docx', APP);
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe(APP);
    expect(r.headers.get('access-control-allow-methods')).toBe('POST');
    expect(r.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
    const c = await preflight('/api/v1/config', APP, 'GET');
    expect([c.status, c.headers.get('access-control-allow-origin')]).toEqual([204, APP]);
  });

  it('refuses other origins, other routes and other methods', async () => {
    env = await sharingEnv({ converter: new EchoConverter() });
    for (const origin of ['https://evil.example', 'http://localhost', 'https://localhost:8443', 'null', 'https://www.rokelapdf.com']) {
      const r = await preflight('/api/v1/convert/pdf?name=a.docx', origin);
      expect([origin, r.status, r.headers.get('access-control-allow-origin')]).toEqual([origin, 404, null]);
    }
    for (const [path, method] of [
      ['/api/v1/me', 'GET'],
      ['/api/v1/workspaces/org_x/sharing/documents', 'POST'],
      ['/api/v1/convert/pdf', 'GET'],
      ['/api/v1/config', 'POST'],
      ['/api/v1/nope', 'GET'],
    ] as const) {
      const r = await preflight(path, APP, method);
      expect([path, method, r.status, r.headers.get('access-control-allow-origin')]).toEqual([path, method, 404, null]);
    }
  });
});

describe('app CORS: requests', () => {
  it('lets the app read a conversion, its file name and its errors', async () => {
    env = await sharingEnv({ converter: new EchoConverter() });
    const u = await env.user('app@example.test', { verified: true });
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]);
    const ok = await env.call('POST', '/api/v1/convert/pdf?name=report.docx', { token: u.token, raw: docx, headers: { origin: APP } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(APP);
    expect(ok.headers.get('access-control-expose-headers')).toContain('content-disposition');
    expect(ok.headers.get('vary')).toContain('origin');
    const anon = await env.call('POST', '/api/v1/convert/pdf?name=report.docx', { raw: docx, headers: { origin: APP } });
    expect([anon.status, anon.headers.get('access-control-allow-origin')]).toEqual([401, APP]);
    const cfg = await env.call('GET', '/api/v1/config', { headers: { origin: APP } });
    expect([cfg.status, cfg.headers.get('access-control-allow-origin'), cfg.body.convert]).toEqual([200, APP, true]);
  });

  it('never sends CORS headers to another origin or on a route the app cannot use', async () => {
    env = await sharingEnv({ converter: new EchoConverter() });
    const u = await env.user('web@example.test', { verified: true });
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]);
    const other = await env.call('POST', '/api/v1/convert/pdf?name=report.docx', { token: u.token, raw: docx, headers: { origin: 'https://evil.example' } });
    expect(other.status).toBe(200); // bearer auth, no cookies: the request itself is not the risk
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    expect(other.headers.get('vary')).toContain('origin');
    const me = await env.call('GET', '/api/v1/me', { token: u.token, headers: { origin: APP } });
    expect(me.status).toBe(200);
    expect(me.headers.get('access-control-allow-origin')).toBeNull();
    const health = await env.call('GET', '/api/v1/health', { headers: { origin: APP } });
    expect(health.headers.get('access-control-allow-origin')).toBeNull();
  });
});
