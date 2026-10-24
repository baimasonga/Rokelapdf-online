import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { checkWarriorReadiness, pingClamd } from '@/lib/server/warrior-readiness';

const config = {
  warrior: {
    token: 'private-token',
    apiComponentId: 'opm_' + 'a'.repeat(24),
    converterComponentId: 'opm_' + 'b'.repeat(24),
    scannerComponentId: 'opm_' + 'c'.repeat(24),
  },
  converter: { url: 'http://converter.internal:8080', token: 'private-converter-token' },
  clamd: { host: 'scanner.internal', port: 3310 },
};
const monitor = () => ({ capture: vi.fn(async () => true), scannerUnavailable: vi.fn(async () => undefined) });
const status = (s: string) => ({ type: 'component.heartbeat', attributes: { status: s } });
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});
it('checks configured dependencies without documents, tokens or redirects and reports idle readiness', async () => {
  const m = monitor();
  const request = vi.fn(async () => Response.json({ ok: true, service: 'rokela-converter' }));
  const ping = vi.fn(async () => undefined);
  await checkWarriorReadiness(config, m, { fetch: request as typeof fetch, ping });
  expect(request).toHaveBeenCalledWith(
    'http://converter.internal:8080/health',
    expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
  );
  expect(JSON.stringify(request.mock.calls)).not.toContain('private-');
  expect(ping).toHaveBeenCalledWith(config.clamd);
  expect(m.capture).toHaveBeenCalledWith(config.warrior.converterComponentId, status('healthy'));
  expect(m.capture).toHaveBeenCalledWith(config.warrior.scannerComponentId, status('healthy'));
  expect(m.scannerUnavailable).not.toHaveBeenCalled();
});
it.each([
  () => Response.json({ ok: true, service: 'wrong-service' }),
  () => Response.json({ ok: false, service: 'rokela-converter' }),
  () => Response.json({ ok: true, service: 'rokela-converter' }, { status: 503 }),
  () => new Response('x'.repeat(4097)),
  () => new Response('not json'),
])('rejects unhealthy, wrong, malformed and oversized converter responses', async (response) => {
  const m = monitor();
  await checkWarriorReadiness(config, m, { fetch: (async () => response()) as typeof fetch, ping: async () => undefined });
  expect(m.capture).toHaveBeenCalledWith(config.warrior.converterComponentId, status('unavailable'));
  expect(m.capture).toHaveBeenCalledWith(config.warrior.scannerComponentId, status('healthy'));
});
it('reports scanner outage and recovery independently of converter and collector failures', async () => {
  const m = monitor();
  const request = (async () => {
    throw new Error('private upstream details');
  }) as typeof fetch;
  await checkWarriorReadiness(config, m, {
    fetch: request,
    ping: async () => {
      throw new Error('private scanner details');
    },
  });
  expect(m.capture).toHaveBeenCalledWith(config.warrior.scannerComponentId, status('unavailable'));
  expect(m.scannerUnavailable).toHaveBeenCalledWith(config.warrior.scannerComponentId);
  m.capture.mockClear();
  await checkWarriorReadiness(config, m, { fetch: request, ping: async () => undefined });
  expect(m.capture).toHaveBeenCalledWith(config.warrior.scannerComponentId, status('healthy'));
  m.capture.mockRejectedValue(new Error('collector down'));
  await expect(checkWarriorReadiness(config, m, { fetch: request, ping: async () => undefined })).resolves.toBeUndefined();
});
it('keeps unconfigured dependencies unknown and does nothing when monitoring is disabled', async () => {
  const m = monitor(),
    request = vi.fn(),
    ping = vi.fn();
  await checkWarriorReadiness({ ...config, converter: undefined, clamd: undefined }, m, { fetch: request, ping });
  expect(m.capture).toHaveBeenCalledWith(config.warrior.scannerComponentId, status('unknown'));
  expect(m.capture).toHaveBeenCalledWith(config.warrior.converterComponentId, status('unknown'));
  expect(request).not.toHaveBeenCalled();
  expect(ping).not.toHaveBeenCalled();
  m.capture.mockClear();
  await checkWarriorReadiness({ ...config, warrior: undefined }, m, { fetch: request, ping });
  expect(m.capture).not.toHaveBeenCalled();
});
async function daemon(reply: string | null) {
  let command = '';
  const server = createServer((socket) => {
    socket.on('data', (data) => {
      command += data.toString();
      if (reply !== null) socket.end(reply);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port, command: () => command };
}
it('requires a real ClamAV PONG and uses only the bounded PING command', async () => {
  const s = await daemon('PONG\0');
  await pingClamd(s);
  expect(s.command()).toBe('zPING\0');
  await expect(pingClamd(await daemon('wrong\0'))).rejects.toThrow();
  await expect(pingClamd(await daemon('x'.repeat(65)))).rejects.toThrow();
});
it('bounds a silent scanner connection by a total deadline', async () => {
  await expect(pingClamd({ ...(await daemon(null)), timeoutMs: 30 })).rejects.toThrow();
});
it('aborts a converter response stalled during its body within five seconds', async () => {
  vi.useFakeTimers();
  try {
    const m = monitor();
    const request = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
            },
          }),
        ),
    );
    const check = checkWarriorReadiness(config, m, { fetch: request as typeof fetch, ping: async () => undefined });
    await vi.advanceTimersByTimeAsync(5000);
    await check;
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(m.capture).toHaveBeenCalledWith(config.warrior.converterComponentId, status('unavailable'));
  } finally {
    vi.useRealTimers();
  }
});
