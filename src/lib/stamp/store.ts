import { cleanDesign, type StampDesign } from './design';

// The person's stamps, kept in this browser (or app) only. Nothing is uploaded; clearing site data removes them.

const KEY = 'rokela.stamps.v1';

export function loadStamps(): StampDesign[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw)
      ? raw
          .map(cleanDesign)
          .filter((d): d is StampDesign => !!d)
          .slice(0, 50)
      : [];
  } catch {
    return [];
  }
}

export function saveStamps(list: StampDesign[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 50)));
  } catch {
    // Private windows and full storage: the stamp still works until the page closes.
  }
}

/** Saves one stamp (new or changed) and returns the updated list. */
export function upsertStamp(d: StampDesign): StampDesign[] {
  const list = loadStamps();
  const i = list.findIndex((x) => x.id === d.id);
  if (i >= 0) list[i] = d;
  else list.unshift(d);
  saveStamps(list);
  return list;
}

export function deleteStamp(id: string): StampDesign[] {
  const list = loadStamps().filter((x) => x.id !== id);
  saveStamps(list);
  return list;
}
