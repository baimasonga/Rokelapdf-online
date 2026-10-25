import { Directory, Filesystem } from '@capacitor/filesystem';
import { fromBase64, native, toBase64, type PdfFile } from './native';

// Recent files, like a document app's home screen: every PDF opened, scanned or created is kept on this phone (the
// app's private storage) so it can be reopened later. Nothing leaves the device. In a browser preview the list lasts
// only until the page reloads.

export interface Recent {
  id: string;
  name: string;
  size: number;
  pages: number;
  at: number;
}

const KEY = 'rokela-recent';
/** How many files Recent keeps; older ones are deleted from the phone. */
export const RECENT_MAX = 15;
const MAX = RECENT_MAX;
const memory = new Map<string, Uint8Array>();

function read(): Recent[] {
  if (!native) return [...memoryIndex];
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Recent[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
let memoryIndex: Recent[] = [];
function write(list: Recent[]) {
  if (!native) return void (memoryIndex = list);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable: the list just is not remembered */
  }
}
const path = (id: string) => `recent/${id}.pdf`;

export const recentFiles = (): Recent[] => read().sort((a, b) => b.at - a.at);

/** Remembers a file (replacing an older copy with the same name and size) and returns the new list. */
export async function remember(file: PdfFile, pages: number): Promise<Recent[]> {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const entry: Recent = { id, name: file.name, size: file.bytes.length, pages, at: Date.now() };
  const old = read();
  const dropped = old.filter((r) => r.name === entry.name && r.size === entry.size);
  const kept = old.filter((r) => !dropped.includes(r)).sort((a, b) => b.at - a.at);
  const next = [entry, ...kept].slice(0, MAX);
  const gone = [...dropped, ...kept.slice(MAX - 1)];
  try {
    if (native) await Filesystem.writeFile({ path: path(id), data: toBase64(file.bytes), directory: Directory.Data, recursive: true });
    else memory.set(id, file.bytes);
  } catch {
    return recentFiles(); // could not store it (phone full): keep the old list
  }
  write(next);
  await Promise.all(gone.map((r) => forget(r.id, false)));
  return recentFiles();
}

export async function openRecent(id: string): Promise<PdfFile> {
  const r = read().find((x) => x.id === id);
  if (!r) throw new Error('That file is no longer in Recent.');
  try {
    const bytes = native ? fromBase64((await Filesystem.readFile({ path: path(id), directory: Directory.Data })).data as string) : memory.get(id);
    if (!bytes) throw new Error();
    return { name: r.name, bytes };
  } catch {
    await forget(id);
    throw new Error('That file could not be found any more. It has been removed from Recent.');
  }
}

/** Removes a file from Recent (and deletes the copy kept by the app). */
export async function forget(id: string, updateIndex = true): Promise<Recent[]> {
  if (updateIndex) write(read().filter((r) => r.id !== id));
  if (native) await Filesystem.deleteFile({ path: path(id), directory: Directory.Data }).catch(() => undefined);
  else memory.delete(id);
  return recentFiles();
}
