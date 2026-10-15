'use client';
import { useEffect, useState } from 'react';
import { Badge, Button, CopyField, Details, Empty, Form, Muted, Panel, Table, ask, useNotice } from '@/components/ui';
import { api, apiBlob, enc } from '@/lib/client/api';
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data, error, reload } = useLoad<any>(() => api(`${P}/short-links${q ? `?q=${enc(q)}` : ''}`), [P, q]);
  const bulk =
    (action: string, extra: Record<string, string> = {}) =>
    async () => {
      if (!selected.size) return notice('Select links first.', true);
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
            { name: 'alias', label: 'Custom alias', optional: true },
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
        <input type="search" placeholder="Search code, label or destination" aria-label="Search short links" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="actions">
          <Button onClick={bulk('suspend')}>Suspend selected</Button>
          <Button onClick={bulk('resume')}>Resume selected</Button>
          <Button onClick={async () => bulk('move', { folder: ask('Folder name:') ?? '' })()}>Move selected…</Button>
          <Button onClick={async () => bulk('tag', { tag: ask('Tag:') ?? '' })()}>Tag selected…</Button>
          <Button kind="danger" onClick={bulk('revoke')}>
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
              s.url,
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
  useEffect(() => {
    let u: string | undefined;
    apiBlob(path).then(
      (b) => setUrl((u = URL.createObjectURL(b))),
      () => setUrl(undefined),
    );
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [path]);
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
