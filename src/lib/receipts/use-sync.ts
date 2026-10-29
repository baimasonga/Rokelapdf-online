import { useCallback, useEffect, useRef, useState } from 'react';
import { loadWorldState, saveWorldState, syncBusinesses, type SyncLocal, type SyncPost, type SyncWorld } from './sync';
import { deviceDocs } from './docs';

// Keeps the Receipt Maker in sync with the person's account (docs/receipt-sync.md), on the website and in the Android
// app, every business at once: shortly after each change, when the screen opens, and every few minutes while it is
// open.

export type SyncStatus =
  | { k: 'signed-out' }
  | { k: 'syncing' }
  /** `localOnly`: businesses the account turned away (it holds as many as it can); they stay on this device. */
  | { k: 'synced'; at: number; localOnly: string[] }
  | { k: 'error'; message: string };

/** The signed-in person (their id) and a way to call /api/v1/me/receipt-sync as them, or null when signed out. */
export type SyncSession = () => Promise<{ user: string; post: SyncPost } | null>;

const PAUSE_MS = 2500;
/** A cheap fingerprint of what would be sent: entry count, update times, numbering and the profile's time. */
const stepKey = (l: SyncLocal) => JSON.stringify([l.entries.length, l.counters, l.businessAt, l.entries.map((e) => e.updatedAt ?? 0)]);
const EVERY_MS = 3 * 60_000;

export function useReceiptSync(o: {
  /** False until the device's own data has been read. */
  ready: boolean;
  /** The business open on screen ('' for none), and what it holds: changes to it start a sync shortly after. */
  open: string;
  local: SyncLocal;
  /** The businesses on this device ("main,b12…"): adding one starts a sync too. */
  businesses: string;
  /** Everything every business on this device holds, read when a sync starts. */
  world: () => SyncWorld;
  session: SyncSession;
  /** Applies merged data from the account, for every business. */
  onMerged: (merged: SyncWorld) => void;
}) {
  const [status, setStatus] = useState<SyncStatus>({ k: 'signed-out' });
  const running = useRef(false);
  /** What was last in step with the account, so an unchanged ledger is not sent again. */
  const inStep = useRef<string>('');
  const latest = useRef(o);
  useEffect(() => {
    latest.current = o;
  });
  const key = `${o.businesses}|${stepKey(o.local)}`;

  const syncNow = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const s = await latest.current.session();
      if (!s) return setStatus({ k: 'signed-out' });
      setStatus({ k: 'syncing' });
      const r = await syncBusinesses(latest.current.world(), loadWorldState(s.user), s.post, Date.now(), deviceDocs());
      saveWorldState(r.state);
      latest.current.onMerged(r.world);
      // In step with what the screen shows once it applies the result (a newly found business syncs once more).
      inStep.current = `${latest.current.businesses}|${stepKey(r.world[latest.current.open] ?? latest.current.local)}`;
      setStatus({ k: 'synced', at: Date.now(), localOnly: r.state.retry ?? [] });
    } catch (e) {
      setStatus({ k: 'error', message: (e as Error).message || 'Could not sync.' });
    } finally {
      running.current = false;
    }
  }, []);

  // Shortly after a change made here.
  useEffect(() => {
    if (!o.ready || key === inStep.current) return;
    const t = setTimeout(() => void syncNow(), PAUSE_MS);
    return () => clearTimeout(t);
  }, [o.ready, key, syncNow]);

  // Changes made on another device: now and then while the screen is open, and when it comes back into view.
  useEffect(() => {
    if (!o.ready) return;
    const t = setInterval(() => document.visibilityState === 'visible' && void syncNow(), EVERY_MS);
    const back = () => document.visibilityState === 'visible' && void syncNow();
    document.addEventListener('visibilitychange', back);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', back);
    };
  }, [o.ready, syncNow]);

  return { status, syncNow };
}

/** "Synced just now" / "Synced 5 min ago" … */
export function syncedAgo(at: number, now = Date.now()) {
  const min = Math.floor((now - at) / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
