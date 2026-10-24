import { afterEach, expect, it, vi } from 'vitest';
import { startBackground } from '@/lib/server/worker';
import type { Container } from '@/lib/server/container';
const workers: ReturnType<typeof startBackground>[] = [];
afterEach(() => {
  for (const w of workers.splice(0)) w.stop();
  vi.useRealTimers();
});
function container(probe?: () => Promise<void>) {
  return {
    config: { storage: { kind: 's3' }, clamd: { host: 'private' }, jobIntervalSeconds: 5, maintenanceIntervalSeconds: 60 },
    sharing: { processJobs: vi.fn(async () => ({ done: 0, failed: 0 })), runRetention: vi.fn(async () => undefined) },
    rateLimiter: { purge: vi.fn(async () => undefined) },
    clock: { now: () => new Date() },
    warriorReadiness: probe,
  } as unknown as Container;
}
it('checks on startup and every minute, independently of document jobs, then stops', async () => {
  vi.useFakeTimers();
  const probe = vi.fn(async () => undefined),
    c = container(probe),
    w = startBackground(c);
  workers.push(w);
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(120000);
  expect(probe).toHaveBeenCalledTimes(3);
  expect(c.sharing.processJobs).toHaveBeenCalled();
  w.stop();
  await vi.advanceTimersByTimeAsync(120000);
  expect(probe).toHaveBeenCalledTimes(3);
});
it('never overlaps readiness runs and survives a probe failure', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const probe = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const w = startBackground(container(probe));
  workers.push(w);
  await vi.advanceTimersByTimeAsync(120000);
  expect(probe).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(0);
  probe.mockImplementation(async () => {
    throw new Error('upstream private details');
  });
  await vi.advanceTimersByTimeAsync(60000);
  expect(probe).toHaveBeenCalledTimes(2);
  probe.mockImplementation(async () => undefined);
  await vi.advanceTimersByTimeAsync(60000);
  expect(probe).toHaveBeenCalledTimes(3);
});
it('does not schedule dependency checks with monitoring disabled', async () => {
  vi.useFakeTimers();
  const w = startBackground(container());
  workers.push(w);
  await vi.advanceTimersByTimeAsync(60000);
  await expect(w.runReadiness()).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(2);
});
