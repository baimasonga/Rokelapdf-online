import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUsageReporter, ANALYTICS_ENDPOINT } from '../src/analytics.ts';
function storage() {
  const values = new Map();
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k), values };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('sends only fixed anonymous fields and clears an acknowledged batch', async () => {
  const store = storage();
  const calls = [];
  const reporter = createUsageReporter({
    storage: store,
    uuid: randomUUID,
    request: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ accepted: 1 }, { status: 202 });
    },
  });
  reporter.track('app_open', '1.2.3', 14, 'phone');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ANALYTICS_ENDPOINT);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ['events', 'installation_id']);
  assert.deepEqual(Object.keys(body.events[0]).sort(), ['app_version', 'device_class', 'feature', 'id', 'occurred_at', 'os_major']);
  assert.equal(JSON.parse(store.getItem('rokela-usage-v1')).queue.length, 0);
});
test('offline retries preserve IDs, bound the queue, and expire old reports', async () => {
  let now = Date.now();
  let online = false;
  const sent = [];
  const store = storage();
  const reporter = createUsageReporter({
    storage: store,
    uuid: randomUUID,
    now: () => now,
    request: async (_url, o) => {
      if (!online) throw new Error('offline');
      const body = JSON.parse(o.body);
      sent.push(body);
      return Response.json({ accepted: body.events.length }, { status: 202 });
    },
  });
  reporter.track('scan', '1', null, 'unknown');
  await tick();
  for (let i = 0; i < 120; i++) reporter.track('edit', '1', 14, 'phone');
  const queued = JSON.parse(store.getItem('rokela-usage-v1')).queue;
  assert.equal(queued.length, 100);
  online = true;
  now += 1800000;
  await reporter.flush();
  assert.equal(sent[0].events[0].id, queued[0].id);
  now += 8 * 86400000;
  await reporter.flush();
  assert.equal(JSON.parse(store.getItem('rokela-usage-v1')).queue.length, 0);
});
test('opt-out clears queued identity and persists across restarts', async () => {
  const store = storage();
  let calls = 0;
  const request = async () => {
    calls++;
    throw new Error('offline');
  };
  const reporter = createUsageReporter({ storage: store, uuid: randomUUID, request });
  reporter.track('open', '1', null, 'phone');
  await tick();
  const before = calls;
  reporter.setEnabled(false);
  reporter.track('scan', '1', null, 'phone');
  await reporter.flush();
  assert.equal(store.getItem('rokela-usage-v1'), null);
  assert.equal(calls, before);
  const next = createUsageReporter({ storage: store, uuid: randomUUID, request });
  assert.equal(next.enabled(), false);
  next.track('scan', '1', null, 'phone');
  await tick();
  assert.equal(calls, before);
});
test('unavailable storage disables reporting and restored data cannot smuggle private fields', async () => {
  let calls = 0;
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {},
  };
  const reporter = createUsageReporter({
    storage: broken,
    request: async () => {
      calls++;
      return Response.json({});
    },
  });
  reporter.track('scan', '1', null, 'phone');
  await tick();
  assert.equal(calls, 0);
  const store = storage();
  store.setItem(
    'rokela-usage-v1',
    JSON.stringify({
      installation: randomUUID(),
      queue: [
        {
          id: randomUUID(),
          occurred_at: new Date().toISOString(),
          feature: 'open',
          app_version: '1',
          os_major: null,
          device_class: 'unknown',
          filename: 'PRIVATE.pdf',
        },
      ],
    }),
  );
  let body;
  const restored = createUsageReporter({
    storage: store,
    request: async (_u, o) => {
      body = o.body;
      return Response.json({ accepted: 1 }, { status: 202 });
    },
  });
  await restored.flush();
  assert.ok(!body.includes('PRIVATE'));
});
