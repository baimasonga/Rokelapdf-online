import type { Container } from '../container';
import { createContentServer } from '../storage/local';

/**
 * Background work inside the server process: sharing jobs (quarantine checks, object deletion) every few seconds
 * and retention once a minute. Safe with several instances (fenced job claims, idempotent retention). In
 * development with local storage it also starts the separate content origin.
 */
export function startBackground(c: Container) {
  let jobs: Promise<void> | undefined;
  let maint: Promise<void> | undefined;
  let readiness: Promise<void> | undefined;
  const runReadiness = () =>
    (readiness ??= Promise.resolve()
      .then(() => c.warriorReadiness?.())
      .catch(() => undefined)
      .finally(() => (readiness = undefined)));
  const log = (msg: string, e?: unknown) => console.error(JSON.stringify({ level: 'error', msg, name: (e as Error)?.name, message: (e as Error)?.message }));
  const runJobs = () =>
    (jobs ??= (async () => {
      try {
        for (let i = 0; i < 10; i++) {
          const r = await c.sharing.processJobs({ limit: 20 });
          if (r.done + r.failed < 20) break;
        }
        await c.warrior?.flush().catch(() => log('warrior monitor delivery unavailable; durable queue retained'));
      } catch (e) {
        log('sharing jobs failed; pending work stays queued', e);
      }
    })().finally(() => (jobs = undefined)));
  const runMaintenance = () =>
    (maint ??= (async () => {
      try {
        await c.sharing.runRetention();
        await c.rateLimiter.purge(new Date(c.clock.now().getTime() - 3_600_000));
        if (c.warrior && c.config.warrior) {
          await c.pool.query('SELECT 1');
          await c.warrior.capture(c.config.warrior.apiComponentId, { type: 'component.heartbeat', attributes: { status: 'healthy' } });
        }
      } catch (e) {
        log('maintenance failed; will retry', e);
      }
    })().finally(() => (maint = undefined)));
  const t1 = setInterval(() => void runJobs(), c.config.jobIntervalSeconds * 1000);
  const t2 = setInterval(() => void runMaintenance(), c.config.maintenanceIntervalSeconds * 1000);
  const t3 = c.warriorReadiness ? setInterval(() => void runReadiness(), 60_000) : undefined;
  t3?.unref();
  if (c.warriorReadiness) void runReadiness();
  t1.unref();
  t2.unref();
  if (c.config.storage.kind === 'local' && c.localStore) {
    createContentServer(c.localStore, { allowedOrigin: c.config.publicOrigin }).listen(c.config.storage.contentPort, '127.0.0.1');
    console.warn(`LOCAL object storage (development only); content origin ${c.config.storage.contentOrigin}`);
  }
  if (!c.config.clamd) console.warn('uploads get structural checks only; set CLAMD_HOST for antivirus scanning');
  return { stop: () => (clearInterval(t1), clearInterval(t2), clearInterval(t3)), runJobs, runMaintenance, runReadiness };
}
