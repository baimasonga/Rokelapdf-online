'use client';
import { createContext, useContext, useEffect, useRef, useState, type DependencyList } from 'react';
import { ApiError, api, enc, sharingPath } from '@/lib/client/api';
import { fileKey, uploadFile, type UploadProgress } from '@/lib/client/uploader';

export type Tab =
  | 'overview'
  | 'documents'
  | 'transfers'
  | 'links'
  | 'short-links'
  | 'requests'
  | 'notifications'
  | 'members'
  | 'signatures'
  | 'settings'
  | 'activity'
  | 'abuse';
export interface Workspace {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  role: 'owner' | 'admin' | 'member';
}
/** What a new share link points at; passed from a document or transfer to the share-link form. */
export interface LinkTarget {
  target_type: 'document' | 'transfer';
  target_id: string;
  version_mode?: 'latest' | 'fixed';
  version_id?: string;
  label?: string;
}
export interface Nav {
  tab: Tab;
  id?: string | undefined;
  linkTarget?: LinkTarget | undefined;
}
interface WsState {
  me: { id: string; email: string; email_verified: boolean; is_operator?: boolean };
  workspace: Workspace;
  P: string;
  nav: Nav;
  go(tab: Tab, id?: string, linkTarget?: LinkTarget): void;
}
export const WsCtx = createContext<WsState | undefined>(undefined);
export function useWs(): WsState {
  const v = useContext(WsCtx);
  if (!v) throw new Error('useWs outside workspace');
  return v;
}

/** Loads data and exposes reload; errors are kept for display. */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError | Error>();
  const [n, setN] = useState(0);
  // The latest loader, so the effect re-runs only when the caller's dependencies (or reload) change.
  const fnRef = useRef(fn);
  // Runs before the loading effect below (effects run in order), so it always calls the current loader.
  useEffect(() => {
    fnRef.current = fn;
  });
  const key = JSON.stringify(deps);
  useEffect(() => {
    let live = true;
    setError(undefined);
    fnRef.current().then(
      (d) => live && setData(d),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [key, n]);
  return { data, error, reload: () => setN((x) => x + 1), setData };
}

/** Reloads every few seconds while uploaded files are still being checked, so their new status appears by itself. */
export function usePollWhile(active: boolean, reload: () => void, ms = 2500) {
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(reload, ms);
    return () => clearTimeout(t);
  });
}

/** Owner upload with resume. `target` is the upload body without size/name. */
export function ownerUpload<T = unknown>(
  orgId: string,
  file: Blob & { name?: string; lastModified?: number },
  target: Record<string, unknown>,
  onProgress: (p: UploadProgress) => void,
  name?: string,
) {
  const P = sharingPath(orgId);
  const f = file as File;
  return uploadFile<T>({
    file,
    resumeKey: fileKey(`${orgId}:${JSON.stringify(target)}`, f),
    begin: () => api(`${P}/uploads`, { body: { ...target, name: name ?? f.name, size: file.size } }),
    status: (id) => api(`${P}/uploads/${enc(id)}`),
    sign: (id, nums) => api(`${P}/uploads/${enc(id)}/parts`, { body: { part_numbers: nums } }),
    complete: (id) => api(`${P}/uploads/${enc(id)}/complete`, { body: {} }),
    onProgress,
  });
}

export async function ownerDownload(orgId: string, type: string, id: string) {
  const r = await api<{ url: string }>(`${sharingPath(orgId)}/files/download`, { body: { type, id } });
  window.location.assign(r.url);
}
