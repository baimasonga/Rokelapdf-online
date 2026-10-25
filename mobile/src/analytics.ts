// Bounded anonymous usage reports. No file/account data, IP fields, GPS, or backend secrets.
export const ANALYTICS_ENDPOINT = 'https://trustplatform-api-production.up.railway.app/v1/mobile/rokela-pdf/events';
export const FEATURES = [
  'app_open',
  'open',
  'scan',
  'sign',
  'edit',
  'pages',
  'merge',
  'photos',
  'compress',
  'protect',
  'unlock',
  'ocr',
  'fill',
  'convert',
] as const;
type Feature = (typeof FEATURES)[number];
type Event = { id: string; occurred_at: string; feature: Feature; app_version: string; os_major: number | null; device_class: 'phone' | 'tablet' | 'unknown' };
interface Dependencies {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  request?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
}
const KEY = 'rokela-usage-v1';
const PREF = 'rokela-usage-enabled';
const WEEK = 7 * 86400000;
const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export function createUsageReporter({ storage, request = fetch, now = Date.now, uuid = () => crypto.randomUUID() }: Dependencies) {
  let enabled = true,
    installation = '',
    queue: Event[] = [],
    pending = false,
    controller: AbortController | undefined;
  let nextAttempt = 0,
    failures = 0;
  try {
    enabled = storage.getItem(PREF) !== 'off';
    const saved = JSON.parse(storage.getItem(KEY) ?? 'null');
    if (enabled && validId(saved?.installation)) {
      installation = saved.installation;
      if (Array.isArray(saved.queue))
        queue = saved.queue
          .slice(-100)
          .filter(
            (e: Event) =>
              e &&
              validId(e.id) &&
              FEATURES.includes(e.feature) &&
              typeof e.occurred_at === 'string' &&
              Date.parse(e.occurred_at) >= now() - WEEK &&
              Date.parse(e.occurred_at) <= now() + 300000 &&
              typeof e.app_version === 'string' &&
              /^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$/.test(e.app_version) &&
              (e.os_major === null || (Number.isInteger(e.os_major) && e.os_major >= 1 && e.os_major <= 99)) &&
              ['phone', 'tablet', 'unknown'].includes(e.device_class),
          )
          .map((e: Event) => ({
            id: e.id,
            occurred_at: e.occurred_at,
            feature: e.feature,
            app_version: e.app_version,
            os_major: e.os_major,
            device_class: e.device_class,
          }));
    }
  } catch {
    enabled = false;
  }
  function persist() {
    try {
      storage.setItem(KEY, JSON.stringify({ installation, queue }));
    } catch {
      enabled = false;
      queue = [];
      controller?.abort();
    }
  }
  if (enabled && !installation) {
    installation = uuid();
    persist();
  }
  async function flush() {
    if (!enabled || pending || now() < nextAttempt) return;
    queue = queue.filter((e) => Date.parse(e.occurred_at) >= now() - WEEK);
    persist();
    if (!enabled || !queue.length) return;
    pending = true;
    const sent = queue.slice(0, 20);
    const identity = installation;
    controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(), 5000);
    nextAttempt = now() + 60000;
    try {
      const response = await request(ANALYTICS_ENDPOINT, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installation_id: identity, events: sent }),
        signal: controller.signal,
      });
      let acknowledged = false;
      if (response.status === 202) {
        const text = await response.text();
        acknowledged = text.length < 1024 && JSON.parse(text)?.accepted === sent.length;
      }
      if (acknowledged || [400, 409, 413].includes(response.status)) {
        if (enabled && installation === identity) {
          const ids = new Set(sent.map((e) => e.id));
          queue = queue.filter((e) => !ids.has(e.id));
          persist();
        }
        failures = 0;
      } else throw new Error('unavailable');
    } catch {
      failures = Math.min(failures + 1, 5);
      nextAttempt = now() + Math.min(1800000, 60000 * 2 ** failures);
    } finally {
      clearTimeout(timer);
      controller = undefined;
      pending = false;
    }
  }
  return {
    enabled: () => enabled,
    setEnabled(value: boolean) {
      enabled = value;
      controller?.abort();
      queue = [];
      installation = value ? uuid() : '';
      failures = 0;
      nextAttempt = 0;
      try {
        storage.setItem(PREF, value ? 'on' : 'off');
        storage.removeItem(KEY);
        if (value) persist();
      } catch {
        enabled = false;
      }
    },
    track(feature: Feature, version: string, osMajor: number | null, deviceClass: Event['device_class']) {
      if (!enabled || !FEATURES.includes(feature)) return;
      queue.push({
        id: uuid(),
        occurred_at: new Date(now()).toISOString(),
        feature,
        app_version: /^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$/.test(version) ? version : '0',
        os_major: osMajor !== null && Number.isInteger(osMajor) && osMajor >= 1 && osMajor <= 99 ? osMajor : null,
        device_class: deviceClass,
      });
      queue = queue.filter((e) => Date.parse(e.occurred_at) >= now() - WEEK).slice(-100);
      persist();
      void flush();
    },
    flush,
  };
}
