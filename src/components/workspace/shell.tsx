'use client';
import { LegalFooter } from '@/components/legal-footer';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  BadgeCheck,
  Bell,
  FileInput,
  FilePen,
  FileText,
  GraduationCap,
  History,
  House,
  Link2,
  LogOut,
  Menu,
  Plus,
  Send,
  Settings,
  Share2,
  ShieldAlert,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Brand } from '@/components/header';
import { Form, Modal, Panel } from '@/components/ui';
import { api, sharingPath } from '@/lib/client/api';
import { useAuth } from '@/lib/client/auth';
import { WsCtx, type LinkTarget, type Nav, type Tab, type Workspace } from './context';
import { Overview } from './overview';
import { Documents } from './documents';
import { Transfers } from './transfers';
import { ShareLinks } from './links';
import { ShortLinks } from './short-links';
import { SignatureRequests } from './signatures';
import { VerifiedDocuments } from './verified';
import { FeeClearance } from './fees';
import { Requests } from './requests';
import { Notifications } from './notifications';
import { Members } from './members';
import { ReceivedInvitations, type ReceivedInvitation } from './invitations';
import { WorkspaceSettings } from './settings';
import { WorkspaceActivity } from './activity';
import { MonitoringStatus } from './monitoring';
import { AbuseReview } from './abuse';

const TABS: Array<[Tab, string, LucideIcon, string]> = [
  ['overview', 'Home', House, 'Send, edit and share your files.'],
  ['documents', 'Documents', FileText, 'Drafts, versions and what is published.'],
  ['transfers', 'Send files', Send, 'Send files by email or link, and see who downloaded them.'],
  ['links', 'Share links', Share2, 'Every link to your documents and transfers.'],
  ['short-links', 'Short links', Link2, 'Short URLs and QR codes, with destination history and stats.'],
  ['requests', 'Upload requests', FileInput, 'Collect files from anyone, with a checklist and deadline.'],
  ['notifications', 'Notifications', Bell, 'Access, downloads, receipts and submissions.'],
  ['members', 'Members', Users, 'Who can work in this team workspace.'],
  ['signatures', 'Request signatures', FilePen, 'Send a fixed PDF for signing and collect the signed copy.'],
  ['verified', 'Verified documents', BadgeCheck, 'Issue PDFs with a QR code anyone can scan to confirm they are genuine.'],
  ['fees', 'Receipt processing', GraduationCap, 'Check bank receipts from students, customers or members against the statement and issue certificates.'],
  ['settings', 'Settings', Settings, 'Branding, custom domains and workspace limits.'],
  ['activity', 'Activity', History, 'Audit history and workspace data exports.'],
  ['monitoring', 'Monitoring', Activity, 'Warrior delivery status and backlog.'],
  ['abuse', 'Abuse review', ShieldAlert, 'Platform operator review of reported links.'],
];
const isTab = (t: string | null): t is Tab => TABS.some(([k]) => k === t);
const initial = (email: string) => email.slice(0, 1) || '?';

export function WorkspaceApp() {
  const { ready, session } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [me, setMe] = useState<{
    user: { id: string; email: string; email_verified: boolean; is_operator?: boolean };
    workspaces: Workspace[];
    invitations: ReceivedInvitation[];
  }>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [linkTarget, setLinkTarget] = useState<LinkTarget>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const { signOut } = useAuth();

  useEffect(() => {
    if (ready && !session) router.replace(`/signin?next=${encodeURIComponent(`/app${window.location.search}`)}`);
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

  useEffect(() => {
    if (!workspace) return;
    api<{ items: Array<{ read: boolean }> }>(`${sharingPath(workspace.id)}/notifications`).then(
      (r) => setUnread(r.items.filter((n) => !n.read).length),
      () => setUnread(0),
    );
  }, [workspace, nav.tab]);

  if (error)
    return (
      <main className="narrow">
        <Panel title="Could not load your workspace">{error}</Panel>
      </main>
    );
  if (!me || !workspace) return <p className="muted center">Loading…</p>;
  const ctx = { me: me.user, workspace, P: sharingPath(workspace.id), nav, go, refresh: loadMe };
  const View = {
    overview: Overview,
    documents: Documents,
    transfers: Transfers,
    links: ShareLinks,
    'short-links': ShortLinks,
    requests: Requests,
    signatures: SignatureRequests,
    verified: VerifiedDocuments,
    fees: FeeClearance,
    notifications: Notifications,
    members: Members,
    settings: WorkspaceSettings,
    activity: WorkspaceActivity,
    abuse: AbuseReview,
    monitoring: MonitoringStatus,
  }[nav.tab];

  const current = TABS.find(([t]) => t === nav.tab)!;
  const navItem = ([t, label, Icon]: (typeof TABS)[number]) => (
    <button
      key={t}
      type="button"
      aria-current={nav.tab === t ? 'page' : undefined}
      onClick={() => {
        setMenuOpen(false);
        go(t);
      }}
    >
      <Icon size={18} aria-hidden="true" /> {label}
      {t === 'notifications' && unread > 0 && (
        <span className="count" aria-label={`${unread} unread`}>
          {unread}
        </span>
      )}
    </button>
  );

  return (
    <WsCtx.Provider value={ctx}>
      <div className="app">
        <div className="mobile-bar">
          <button type="button" className="ghost icon-btn" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            <Menu size={20} aria-hidden="true" />
          </button>
          <Brand href="/app" />
          <span />
        </div>
        {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
        <aside className={`sidebar${menuOpen ? ' open' : ''}`} aria-label="Workspace navigation">
          <div className="actions" style={{ margin: 0, justifyContent: 'space-between' }}>
            <Brand href="/app" />
            {menuOpen && (
              <button type="button" className="ghost icon-btn" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
                <X size={18} aria-hidden="true" />
              </button>
            )}
          </div>
          <label className="ws-switch">
            <span className="sr-only">Workspace</span>
            <select
              value={workspace.id}
              onChange={(e) => {
                setLinkTarget(undefined);
                setMenuOpen(false);
                router.push(`/app?ws=${encodeURIComponent(e.target.value)}`);
              }}
            >
              {me.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.kind === 'personal' ? 'Personal workspace' : w.name}
                </option>
              ))}
            </select>
          </label>
          <Link href={`/edit`} className="button primary">
            <FilePen size={16} aria-hidden="true" /> Edit a PDF
          </Link>
          <nav className="nav" aria-label="Files and links">
            {TABS.slice(0, 1).map(navItem)}
            <div className="nav-label">Share</div>
            {TABS.slice(1, 6).map(navItem)}
            <div className="nav-label">Workspace</div>
            {TABS.slice(6)
              .filter(
                ([t]) =>
                  (t !== 'members' || workspace.kind === 'team') &&
                  (!['abuse', 'monitoring'].includes(t) || me.user.is_operator) &&
                  (t !== 'activity' || workspace.role !== 'member'),
              )
              .map(navItem)}
            <button type="button" onClick={() => setCreating(true)}>
              <Plus size={18} aria-hidden="true" /> New team workspace
            </button>
          </nav>
          <div className="sidebar-foot">
            <div className="user-chip" title={me.user.email}>
              <span className="avatar" aria-hidden="true">
                {initial(me.user.email)}
              </span>
              <span>{me.user.email}</span>
            </div>
            <div className="nav">
              <button
                type="button"
                onClick={async () => {
                  await signOut();
                  router.push('/');
                }}
              >
                <LogOut size={18} aria-hidden="true" /> Sign out
              </button>
            </div>
          </div>
        </aside>
        <main className="app-main">
          <div className="page-head">
            <div>
              <h1>{nav.tab === 'overview' ? (workspace.kind === 'personal' ? 'Welcome back' : workspace.name) : current[1]}</h1>
              <p>{current[3]}</p>
            </div>
          </div>
          {!me.user.email_verified && <div className="notice-bar">Confirm your email address to share with named recipients and use all sharing options.</div>}
          <ReceivedInvitations
            items={me.invitations ?? []}
            onAnswered={async (joined) => {
              await loadMe();
              if (joined) router.push(`/app?ws=${encodeURIComponent(joined)}`);
            }}
          />
          <View key={`${workspace.id}:${nav.tab}:${nav.id ?? ''}`} />
          <LegalFooter />
        </main>
      </div>
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
  return <WorkspaceApp />;
}
