'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Header } from '@/components/header';
import { Button, Form, Modal, Panel } from '@/components/ui';
import { api, sharingPath } from '@/lib/client/api';
import { useAuth } from '@/lib/client/auth';
import { WsCtx, type LinkTarget, type Nav, type Tab, type Workspace } from './context';
import { Overview } from './overview';
import { Documents } from './documents';
import { Transfers } from './transfers';
import { ShareLinks } from './links';
import { ShortLinks } from './short-links';
import { Requests } from './requests';
import { Notifications } from './notifications';
import { Members } from './members';

const TABS: Array<[Tab, string]> = [
  ['overview', 'Overview'],
  ['documents', 'Documents'],
  ['transfers', 'Transfers'],
  ['links', 'Share links'],
  ['short-links', 'Short links'],
  ['requests', 'Upload requests'],
  ['notifications', 'Notifications'],
  ['members', 'Members'],
];
const isTab = (t: string | null): t is Tab => TABS.some(([k]) => k === t);

export function WorkspaceApp() {
  const { ready, session } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [me, setMe] = useState<{ user: { id: string; email: string; email_verified: boolean }; workspaces: Workspace[] }>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [linkTarget, setLinkTarget] = useState<LinkTarget>();

  useEffect(() => {
    if (ready && !session) router.replace('/signin?next=/app');
  }, [ready, session, router]);
  const loadMe = useCallback(() => api('/api/v1/me').then(setMe, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    if (session) void loadMe();
  }, [session, loadMe]);

  const wsId = params.get('ws');
  const workspace = me?.workspaces.find((w) => w.id === wsId) ?? me?.workspaces[0];
  const nav: Nav = useMemo(() => {
    const t = params.get('tab');
    return { tab: isTab(t) ? t : 'overview', id: params.get('id') ?? undefined, linkTarget };
  }, [params, linkTarget]);

  const go = useCallback(
    (tab: Tab, id?: string, target?: LinkTarget) => {
      setLinkTarget(target);
      const q = new URLSearchParams({ ...(workspace ? { ws: workspace.id } : {}), tab, ...(id ? { id } : {}) });
      router.push(`/app?${q}`);
      window.scrollTo({ top: 0 });
    },
    [router, workspace],
  );

  if (error) return <Panel title="Could not load your workspace">{error}</Panel>;
  if (!me || !workspace) return <p className="muted center">Loading…</p>;
  const ctx = { me: me.user, workspace, P: sharingPath(workspace.id), nav, go };
  const View = {
    overview: Overview,
    documents: Documents,
    transfers: Transfers,
    links: ShareLinks,
    'short-links': ShortLinks,
    requests: Requests,
    notifications: Notifications,
    members: Members,
  }[nav.tab];

  return (
    <WsCtx.Provider value={ctx}>
      <div className="ws-bar">
        <label className="ws-switch">
          <span className="sr-only">Workspace</span>
          <select
            value={workspace.id}
            onChange={(e) => {
              setLinkTarget(undefined);
              router.push(`/app?ws=${encodeURIComponent(e.target.value)}`);
            }}
          >
            {me.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.kind === 'personal' ? 'Personal' : w.name} · {w.role}
              </option>
            ))}
          </select>
        </label>
        <Button kind="ghost" onClick={() => setCreating(true)}>
          + Team workspace
        </Button>
        {!me.user.email_verified && <span className="badge off">Email not verified — some sharing options need a verified email</span>}
      </div>
      <nav className="tabs" aria-label="Files and links">
        {TABS.filter(([t]) => t !== 'members' || workspace.kind === 'team').map(([t, label]) => (
          <button key={t} type="button" aria-current={nav.tab === t ? 'page' : undefined} onClick={() => go(t)}>
            {label}
          </button>
        ))}
      </nav>
      <View key={`${workspace.id}:${nav.tab}:${nav.id ?? ''}`} />
      <Modal open={creating} onClose={() => setCreating(false)} title="New team workspace">
        <Form
          fields={[{ name: 'name', label: 'Team name' }]}
          submit="Create workspace"
          onSubmit={async (v) => {
            const w = await api<Workspace>('/api/v1/workspaces', { body: { name: v.name } });
            setCreating(false);
            await loadMe();
            router.push(`/app?ws=${encodeURIComponent(w.id)}&tab=members`);
          }}
        />
      </Modal>
    </WsCtx.Provider>
  );
}

export function WorkspacePage() {
  return (
    <>
      <Header />
      <main className="wide">
        <WorkspaceApp />
      </main>
    </>
  );
}
