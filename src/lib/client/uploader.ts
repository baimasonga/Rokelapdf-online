// Resumable direct uploads. The API authorizes and signs; bytes go straight from the browser to private object
// storage on a separate origin. An interrupted upload resumes from the parts storage already holds: the upload id is
// remembered per file (name, size, modification time) in this browser only, and the server is asked which parts
// arrived. Nothing secret is stored: an upload id alone grants nothing without the session or submission secret.

const KEY = 'rokela-resume:';
function remember(k: string, v: string | null) {
  try {
    if (v) localStorage.setItem(KEY + k, v);
    else localStorage.removeItem(KEY + k);
  } catch {
    /* storage unavailable: uploads still work, they just cannot resume across reloads */
  }
}
function recall(k: string): string | null {
  try {
    return localStorage.getItem(KEY + k);
  } catch {
    return null;
  }
}
export const fileKey = (scope: string, file: File) => `${scope}:${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;
const PARALLEL_PARTS = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UploadProgress {
  sent: number;
  total: number;
  resumed: boolean;
}
export interface UploadOps<T> {
  file: Blob;
  resumeKey: string;
  begin: () => Promise<{ upload_id: string; part_size: number; part_count: number }>;
  status: (id: string) => Promise<{ status: string; part_size: number; part_count: number; uploaded_parts: number[] }>;
  sign: (id: string, nums: number[]) => Promise<{ parts: Array<{ part_number: number; url: string }> }>;
  complete: (id: string) => Promise<T>;
  onProgress?: (p: UploadProgress) => void;
}

export async function uploadFile<T>(o: UploadOps<T>): Promise<T> {
  const total = o.file.size;
  let session: { upload_id: string; part_size: number; part_count: number } | undefined;
  let held: number[] = [];
  let resumed = false;
  const prior = recall(o.resumeKey);
  if (prior) {
    try {
      const st = await o.status(prior);
      if (st.status === 'uploading') {
        session = { upload_id: prior, part_size: st.part_size, part_count: st.part_count };
        held = st.uploaded_parts;
        resumed = true;
      }
    } catch {
      /* expired or unknown: start again */
    }
  }
  if (!session) {
    session = await o.begin();
    remember(o.resumeKey, session.upload_id);
  }
  const size = session.part_size;
  const bytesOf = (n: number) => Math.min(size, total - (n - 1) * size);
  let sent = held.reduce((s, n) => s + bytesOf(n), 0);
  o.onProgress?.({ sent, total, resumed });
  const missing: number[] = [];
  for (let n = 1; n <= session.part_count; n++) if (!held.includes(n)) missing.push(n);
  for (let i = 0; i < missing.length; i += 20) {
    const signed = await o.sign(session.upload_id, missing.slice(i, i + 20));
    const queue = [...signed.parts];
    // A few parts in flight at once: much faster on high-latency links, still gentle on the browser.
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const blob = o.file.slice((p.part_number - 1) * size, p.part_number * size);
        for (let attempt = 1; ; attempt++) {
          try {
            const res = await fetch(p.url, { method: 'PUT', body: blob, credentials: 'omit', mode: 'cors' });
            if (!res.ok) throw new Error(`storage answered ${res.status}`);
            break;
          } catch (e) {
            if (attempt >= 4) throw new Error(`Upload interrupted (${(e as Error).message}). Choose the same file again to resume.`);
            await sleep(500 * 2 ** attempt);
          }
        }
        sent += blob.size;
        o.onProgress?.({ sent, total, resumed });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, queue.length) }, worker));
  }
  const done = await o.complete(session.upload_id);
  remember(o.resumeKey, null);
  return done;
}
