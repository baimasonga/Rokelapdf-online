import { describe, expect, it } from 'vitest';
import { clientIp } from '@/lib/server/api/router';

const req = (headers: Record<string, string>) => new Request('http://app.test/', { headers });

describe('client address for rate limits', () => {
  it('uses the entry appended by the trusted proxy, never one the client supplied', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }), 1)).toBe('203.0.113.9');
    expect(clientIp(req({ 'x-forwarded-for': 'spoofed, 198.51.100.7, 203.0.113.9' }), 1)).toBe('203.0.113.9');
    expect(clientIp(req({ 'x-forwarded-for': 'spoofed, 198.51.100.7, 203.0.113.9' }), 2)).toBe('198.51.100.7');
  });

  it('believes no forwarding header without a trusted proxy', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.10' }), 0)).toBe('unknown');
    expect(clientIp(req({ 'x-real-ip': '203.0.113.10' }), 1)).toBe('unknown');
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }), 2)).toBe('unknown');
  });
});
