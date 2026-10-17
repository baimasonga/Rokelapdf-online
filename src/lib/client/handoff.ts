// Passes a file from one page to another in the same browser (e.g. a tool's result into the editor) without
// uploading it. Stored in IndexedDB on this device only, read once, then deleted.

const DB = 'rokela-handoff';
const STORE = 'files';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putHandoff(bytes: Uint8Array, name: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ bytes, name, at: Date.now() }, 'current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Returns the waiting file (if it is less than 10 minutes old) and removes it. */
export async function takeHandoff(): Promise<{ bytes: Uint8Array; name: string } | undefined> {
  const db = await open();
  const v = await new Promise<{ bytes: Uint8Array; name: string; at: number } | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const get = store.get('current');
    get.onsuccess = () => {
      store.delete('current');
      resolve(get.result);
    };
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return v && Date.now() - v.at < 10 * 60_000 ? { bytes: v.bytes, name: v.name } : undefined;
}
