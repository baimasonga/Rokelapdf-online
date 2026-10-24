'use client';
import { Zip, ZipPassThrough } from 'fflate';

// "Download all": the browser fetches each file from its signed URL and streams them into one ZIP. Files are stored
// (not recompressed) — most are already compressed, and storing keeps memory and CPU low. Where the browser can
// write to disk directly (File System Access API) the ZIP never sits in memory; elsewhere it is assembled in memory,
// so very large sets are better downloaded file by file.

export interface ZipEntry {
  name: string;
  folderPath: string;
  url: string;
  size: number;
}

/** Above this, browsers without direct-to-disk saving are asked to download files one by one. */
export const IN_MEMORY_LIMIT = 2 * 1024 ** 3;
/**
 * fflate writes classic ZIP only (no ZIP64), whose sizes and offsets are 32-bit: an archive past 4 GiB comes out
 * corrupt. Larger sets are downloaded file by file. The margin covers headers and the central directory.
 */
export const ZIP_LIMIT = 4 * 1024 ** 3 - 64 * 1024 ** 2;

type SaveTarget = { write(d: Uint8Array): Promise<void>; close(): Promise<void> };

/** Asks where to save, while the click's user activation is still valid. Undefined: not supported; null: cancelled. */
export async function pickSaveTarget(suggestedName: string): Promise<SaveTarget | null | undefined> {
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(d: BufferSource): Promise<void>; close(): Promise<void> }> }>;
  };
  if (!w.showSaveFilePicker) return undefined;
  try {
    const h = await w.showSaveFilePicker({ suggestedName, types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] });
    const s = await h.createWritable();
    return { write: (d) => s.write(d as BufferSource), close: () => s.close() };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    return undefined;
  }
}

/** Unique, safe paths inside the archive (no absolute paths or "..", duplicates numbered). */
export function archivePaths(entries: Array<Pick<ZipEntry, 'name' | 'folderPath'>>): string[] {
  const seen = new Set<string>();
  return entries.map((e) => {
    const parts = [...e.folderPath.split('/'), e.name]
      .map((p) => p.replace(/[\\:*?"<>|\u0000-\u001f]/g, '_').trim())
      .filter((p) => p && p !== '.' && p !== '..');
    let path = parts.join('/') || 'file';
    if (seen.has(path.toLowerCase())) {
      const m = /^(.*?)(\.[^./]*)?$/.exec(path)!;
      for (let i = 2; seen.has(path.toLowerCase()); i++) path = `${m[1]} (${i})${m[2] ?? ''}`;
    }
    seen.add(path.toLowerCase());
    return path;
  });
}

export async function downloadZip(entries: ZipEntry[], zipName: string, target: SaveTarget | undefined, onProgress: (done: number, total: number) => void) {
  const total = entries.reduce((n, e) => n + e.size, 0);
  if (total > ZIP_LIMIT) throw new Error('These files are too large to download as one ZIP. Download them one by one.');
  const chunks: Uint8Array[] = [];
  let writing: Promise<void> = Promise.resolve();
  let failure: Error | undefined;
  const zip = new Zip((err, data) => {
    if (err) failure = err;
    else if (target) writing = writing.then(() => target.write(data));
    else chunks.push(data);
  });
  const paths = archivePaths(entries);
  let done = 0;
  for (const [i, e] of entries.entries()) {
    const entry = new ZipPassThrough(paths[i]!);
    zip.add(entry);
    const res = await fetch(e.url, { credentials: 'omit' });
    if (!res.ok || !res.body) throw new Error(`“${e.name}” could not be downloaded (${res.status}).`);
    const reader = res.body.getReader();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      entry.push(value, false);
      done += value.length;
      onProgress(done, total);
      // Writing to disk: let pending writes finish so memory stays bounded.
      if (target) await writing;
      if (failure) throw failure;
    }
    entry.push(new Uint8Array(0), true);
  }
  zip.end();
  await writing;
  if (failure) throw failure;
  if (target) return target.close();
  const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
