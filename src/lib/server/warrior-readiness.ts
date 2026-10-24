import 'server-only';
import { connect } from 'node:net';
import type { AppConfig } from './config';
import type { WarriorMonitor } from './warrior';

/** A process-readiness check, not a file scan or a claim about signature freshness. */
export function pingClamd(opts: { host: string; port: number; timeoutMs?: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: opts.host, port: opts.port });
    const timer = setTimeout(() => finish(new Error('scanner readiness deadline')), opts.timeoutMs ?? 5000);
    let settled = false;
    let answer = '';
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }
    socket.once('connect', () => socket.write('zPING\0'));
    socket.on('data', (data) => {
      answer += data.toString('utf8');
      if (answer.length > 64) return finish(new Error('scanner readiness response too large'));
      if (answer.includes('\0')) finish(answer === 'PONG\0' ? undefined : new Error('scanner readiness response invalid'));
    });
    socket.once('error', () => finish(new Error('scanner readiness connection failed')));
    socket.once('close', () => finish(new Error('scanner readiness connection closed')));
  });
}

async function converterReady(url: string, request: typeof fetch): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await request(`${url}/health`, { redirect: 'error', signal: controller.signal });
    reader = response.body?.getReader();
    if (!response.ok || !reader) throw new Error('converter readiness unavailable');
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 4096) throw new Error('converter readiness response too large');
      chunks.push(part.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body?.ok !== true || body?.service !== 'rokela-converter') throw new Error('converter readiness response invalid');
  } finally {
    controller.abort();
    clearTimeout(timer);
    // Cancel without blocking the worker on an uncooperative upstream.
    void reader?.cancel().catch(() => undefined);
  }
}

/** Only operator-configured dependency addresses are contacted. No documents, credentials or response bodies leave here. */
export async function checkWarriorReadiness(
  config: Pick<AppConfig, 'warrior' | 'converter' | 'clamd'>,
  monitor: Pick<WarriorMonitor, 'capture' | 'scannerUnavailable'>,
  deps: { fetch?: typeof fetch; ping?: typeof pingClamd } = {},
): Promise<void> {
  const scope = config.warrior;
  if (!scope) return;
  async function report(component: string, probe: (() => Promise<void>) | undefined, scanner: boolean) {
    let status: 'healthy' | 'unavailable' | 'unknown' = 'unknown';
    if (probe) {
      try {
        await probe();
        status = 'healthy';
      } catch {
        status = 'unavailable';
      }
    }
    await Promise.allSettled([
      monitor.capture(component, { type: 'component.heartbeat', attributes: { status } }),
      ...(scanner && status === 'unavailable' ? [monitor.scannerUnavailable(component)] : []),
    ]);
  }
  await Promise.allSettled([
    report(scope.converterComponentId, config.converter ? () => converterReady(config.converter!.url, deps.fetch ?? fetch) : undefined, false),
    report(scope.scannerComponentId, config.clamd ? () => (deps.ping ?? pingClamd)(config.clamd!) : undefined, true),
  ]);
}
