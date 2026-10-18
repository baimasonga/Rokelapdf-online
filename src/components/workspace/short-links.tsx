'use client';
import { useEffect, useState } from 'react';
import { Badge, Button, CopyField, Details, Empty, Form, Muted, Panel, Table, ask, useNotice } from '@/components/ui';
import { api, apiBlob, enc } from '@/lib/client/api';
import { downloadCsv } from '@/lib/client/csv';
import { inDays, splitList, when } from '@/lib/client/format';
import { useLoad, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function ShortLinks() {
  const { nav } = useWs();
  return nav.id ? <ShortDetail id={nav.id} /> : <ShortList />;
}

function ShortList() {
  const { P, go } = useWs();
  const notice = useNotice();
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('');
  const [tag, setTag] = useState('');
  const [status, setStatus] = useState('');
  const { data: domains } = useLoad<any>(() => api(`${P}/domains`), [P]);
  const query = new URLSearchParams({ ...(q ? { q } : {}), ...(folder ? { folder } : {}), ...(tag ? { tag } : {}), ...(status ? { status } : {}) });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data, error, reload } = useLoad<any>(() => api(`${P}/short-links?${query}`), [P, q, folder, tag, status]);
  const bulk =
    (action: string, extra: Record<string, string> = {}) =>
    async () => {
      if (!selected.size) return notice('Select links first.', true);
      if (selected.size > 100) return notice('Select at most 100 links for a bulk action.', true);
      await api(`${P}/short-links/bulk`, { body: { ids: [...selected], action, ...extra } });
      setSelected(new Set());
      reload();
    };
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  return (
    <>
      <Panel title="New public short link">
        <p className="muted">
          Public links are for web pages and other public addresses. For documents, create a confidential short link from the share link instead.
        </p>
        <Form
          fields={[
            { name: 'destination_url', label: 'Destination', type: 'url', placeholder: 'https://…' },
            { name: 'label', label: 'Label', optional: true },
            { name: 'alias', label: 'Custom alias', optional: true, hint: '3–64 letters, numbers or hyphens. Aliases cannot be changed later.' },
            {
              name: 'domain_id',
              optional: true,
              label: 'Short-link domain',
              type: 'select',
              options: [
                ['', 'Default domain'],
                ...(domains?.items ?? []).filter((d: any) => d.status === 'verified').map((d: any) => [d.id, d.hostname] as [string, string]),
              ],
            },
            { name: 'password', label: 'Password', type: 'password', optional: true, hint: 'At least 8 characters. Leave empty for an unprotected link.' },
            { name: 'require_auth', label: 'Require visitors to sign in', type: 'checkbox' },
            { name: 'folder', label: 'Folder', optional: true },
            { name: 'tags', label: 'Tags, comma separated', optional: true },
            { name: 'days', label: 'Expires after days', type: 'number', optional: true, min: 1 },
          ]}
          submit="Create short link"
          onSubmit={async (f) => {
            const s = await api(`${P}/short-links`, {
              body: {
                kind: 'public',
                destination_type: 'external',
                destination_url: f.destination_url,
                ...(f.label ? { label: f.label } : {}),
                ...(f.domain_id ? { domain_id: f.domain_id } : {}),
                ...(f.password ? { password: f.password } : {}),
                require_auth: f.require_auth === 'yes',
                ...(f.alias ? { alias: f.alias } : {}),
                ...(f.folder ? { folder: f.folder } : {}),
                ...(f.tags ? { tags: splitList(f.tags) } : {}),
                ...(f.days ? { expires_at: inDays(f.days) } : {}),
              },
            });
            go('short-links', s.id);
          }}
        />
      </Panel>
      <Panel title="Short links">
        <input
          type="search"
          placeholder="Search code, label or destination"
          aria-label="Search short links"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSelected(new Set());
          }}
        />
        <div className="form-grid">
          <label>
            Folder
            <input
              value={folder}
              onChange={(e) => {
                setFolder(e.target.value);
                setSelected(new Set());
              }}
            />
          </label>
          <label>
            Tag
            <input
              value={tag}
              onChange={(e) => {
                setTag(e.target.value);
                setSelected(new Set());
              }}
            />
          </label>
          <label>
            Status
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setSelected(new Set());
              }}
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="revoked">Revoked</option>
            </select>
          </label>
        </div>
        <div className="actions">
          <Button onClick={() => setSelected(new Set((data?.items ?? []).slice(0, 100).map((s: any) => s.id)))}>Select up to 100</Button>
          <Button onClick={() => setSelected(new Set())}>Clear selection</Button>
          <Button
            disabled={!data?.items.length}
            onClick={() => {
              const rows = data.items.filter((s: any) => !selected.size || selected.has(s.id));
              downloadCsv('short-links.csv', [
                ['Label', 'Short URL', 'Destination', 'Folder', 'Tags', 'State', 'Expires'],
                ...rows.map((s: any) => [s.label, s.url, s.destination_url, s.folder, s.tags.join(', '), s.state, s.expires_at]),
              ]);
            }}
          >
            Export CSV
          </Button>
          <span role="status">{selected.size} selected</span>
        </div>
        <div className="actions">
          <Button onClick={bulk('suspend')}>Suspend selected</Button>
          <Button onClick={bulk('resume')}>Resume selected</Button>
          <Button
            onClick={async () => {
              const value = ask('Folder name (empty to remove):');
              if (value !== undefined) await bulk('move', { folder: value })();
            }}
          >
            Move selected…
          </Button>
          <Button
            onClick={async () => {
              const value = ask('Tag:');
              if (value?.trim()) await bulk('tag', { tag: value.trim() })();
            }}
          >
            Tag selected…
          </Button>
          <Button
            onClick={async () => {
              const value = ask('Tag to remove:');
              if (value?.trim()) await bulk('untag', { tag: value.trim() })();
            }}
          >
            Remove tag…
          </Button>
          <Button
            kind="danger"
            onClick={async () => {
              if (window.confirm('Revoke the selected links? This cannot be undone.')) await bulk('revoke')();
            }}
          >
            Revoke selected
          </Button>
        </div>
        {error ? (
          <p>{error.message}</p>
        ) : !data ? (
          <Muted>Loading…</Muted>
        ) : data.items.length ? (
          <Table
            head={['', 'Short link', 'Kind', 'Destination', 'Folder / tags', 'State', '']}
            rows={data.items.map((s: any) => [
              <input key="c" type="checkbox" aria-label={`Select ${s.url}`} checked={selected.has(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />,
              <div key="url">
                {s.label && <strong>{s.label}</strong>}
                <CopyField value={s.url} label="Short URL" />
              </div>,
              s.kind,
              s.destination_url || `${s.destination_type} link`,
              [s.folder, ...s.tags].filter(Boolean).join(' · ') || '—',
              <Badge key="s" state={s.state} />,
              <Button key="m" onClick={() => go('short-links', s.id)}>
                Manage
              </Button>,
            ])}
          />
        ) : (
          <Empty>No short links.</Empty>
        )}
      </Panel>
    </>
  );
}

function Qr({ path, name, alt }: { path: string; name: string; alt: string }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let u: string | undefined;
    let live = true;
    apiBlob(path).then(
      (b) => {
        if (live) setUrl((u = URL.createObjectURL(b)));
      },
      (e: Error) => {
        if (live) setError(e.message);
      },
    );
    return () => {
      live = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [path]);
  if (error) return <p role="alert">{error}</p>;
  if (!url) return <Muted>Loading QR code…</Muted>;
  return (
    <div className="qr">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} width={200} height={200} />
      <a href={url} download={name} className="button">
        Download QR code (SVG)
      </a>
    </div>
  );
}

function ShortDetail({ id }: { id: string }) {
  const { P, go } = useWs();
  const { data, error, reload } = useLoad(async () => {
    const [s, hist, stats] = await Promise.all([
      api(`${P}/short-links/${enc(id)}`),
      api(`${P}/short-links/${enc(id)}/history`),
      api(`${P}/short-links/${enc(id)}/stats`),
    ]);
    return { s, hist, stats };
  }, [P, id]);
  if (error) return <Panel title="Short link">{error.message}</Panel>;
  if (!data) return <Muted>Loading…</Muted>;
  const { s, hist, stats } = data;
  const status = (action: string) => async () => {
    await api(`${P}/short-links/${enc(id)}/status`, { body: { action } });
    reload();
  };
  return (
    <>
      <Panel
        title={s.label || s.url}
        actions={
          <Button kind="ghost" onClick={() => go('short-links')}>
            ← All short links
          </Button>
        }
      >
        <CopyField value={s.url} label="Short URL" />
        <Details
          items={[
            ['Kind', s.kind],
            ['State', <Badge key="s" state={s.state} />],
            ['Destination', s.destination_url || `${s.destination_type} link`],
            ['Expires', when(s.expires_at)],
            ['Folder', s.folder || '—'],
            ['Tags', s.tags.join(', ') || '—'],
          ]}
        />
        <div className="actions">
          {s.status === 'active' && <Button onClick={status('suspend')}>Suspend</Button>}
          {s.status === 'suspended' && !s.operator_hold && <Button onClick={status('resume')}>Resume</Button>}
          {(s.status === 'active' || s.status === 'suspended') && (
            <Button kind="danger" onClick={status('revoke')}>
              Revoke
            </Button>
          )}
        </div>
        {s.operator_hold && <p className="badge off">Suspended by the platform after an abuse review.</p>}
      </Panel>
      <Panel title="Link settings">
        <Form
          key={s.updated_at}
          fields={[
            { name: 'label', label: 'Label', value: s.label ?? '', optional: true },
            { name: 'folder', label: 'Folder', value: s.folder ?? '', optional: true },
            { name: 'tags', label: 'Tags, comma separated', value: s.tags.join(', '), optional: true },
            { name: 'days', label: 'Set expiry from today (days)', type: 'number', min: 1, optional: true },
            { name: 'remove_expiry', label: 'Remove expiry', type: 'checkbox' },
            ...(s.kind === 'public'
              ? [
                  { name: 'require_auth', label: 'Require visitors to sign in', type: 'checkbox' as const, value: s.require_auth ? 'yes' : '' },
                  {
                    name: 'password',
                    label: s.has_password ? 'Replace password' : 'Set password',
                    type: 'password' as const,
                    optional: true,
                    hint: 'At least 8 characters. Leave empty to keep the current setting.',
                  },
                  { name: 'remove_password', label: 'Remove password', type: 'checkbox' as const },
                ]
              : []),
          ]}
          submit="Save link settings"
          onSubmit={async (f) => {
            if (f.password && f.remove_password === 'yes') throw new Error('Choose either a new password or remove password.');
            if (f.days && f.remove_expiry === 'yes') throw new Error('Choose either an expiry or remove expiry.');
            await api(`${P}/short-links/${enc(id)}`, {
              method: 'PATCH',
              body: {
                label: f.label || null,
                folder: f.folder,
                tags: splitList(f.tags),
                ...(f.remove_expiry === 'yes' ? { expires_at: null } : f.days ? { expires_at: inDays(f.days) } : {}),
                ...(s.kind === 'public'
                  ? {
                      require_auth: f.require_auth === 'yes',
                      ...(f.remove_password === 'yes' ? { password: null } : f.password ? { password: f.password } : {}),
                    }
                  : {}),
              },
            });
            reload();
          }}
        />
      </Panel>
      <Panel title="QR code">
        <Qr path={`${P}/short-links/${enc(id)}/qr.svg`} name={`qr-${s.code || s.id}.svg`} alt={`QR code for ${s.url}`} />
      </Panel>
      {s.kind === 'public' && (
        <Panel title="Change destination">
          <Form
            fields={[
              { name: 'destination_url', label: 'New destination', type: 'url', value: s.destination_url },
              { name: 'reason', label: 'Reason (kept in the history)', optional: true },
            ]}
            submit="Update destination"
            onSubmit={async (f) => {
              await api(`${P}/short-links/${enc(id)}`, {
                method: 'PATCH',
                body: { destination_url: f.destination_url, ...(f.reason ? { reason: f.reason } : {}) },
              });
              reload();
            }}
          />
        </Panel>
      )}
      <Panel title="Destination history">
        <Table
          head={['When', 'Destination', 'By', 'Reason']}
          rows={hist.items.map((h: any) => [when(h.created_at), h.destination_url || `${h.destination_type} link`, h.changed_by, h.reason || '—'])}
        />
      </Panel>
      <Panel title="Visits (last 90 days)">
        {stats.notes.map((n: string) => (
          <p key={n} className="muted">
            {n}
          </p>
        ))}
        {stats.daily.length ? (
          <Table head={['Day', 'Visits', 'Likely automated']} rows={stats.daily.map((d: any) => [d.day, d.visits, d.bots])} />
        ) : (
          <Empty>No visits yet.</Empty>
        )}
        {stats.referrers ? (
          stats.referrers.length ? (
            <Table head={['Referring site (approximate)', 'Visits']} rows={stats.referrers.map((r: any) => [r.host, r.count])} />
          ) : (
            <Empty>No referral information.</Empty>
          )
        ) : (
          <Muted>Referral breakdown is available with advanced analytics.</Muted>
        )}
      </Panel>
    </>
  );
}
