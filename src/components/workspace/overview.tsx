'use client';
import Link from 'next/link';
import { ChevronRight, FileInput, FilePen, Link2, Send } from 'lucide-react';
import { Badge, Muted } from '@/components/ui';
import { api } from '@/lib/client/api';
import { fmtBytes } from '@/lib/client/format';
import { useLoad, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Overview() {
  const { P, go } = useWs();
  const { data: o } = useLoad<any>(() => api(`${P}/overview`), [P]);
  const { data: t } = useLoad<any>(() => api(`${P}/transfers`), [P]);
  const recent = (t?.items ?? [])
    .slice()
    .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 5);
  const actions = [
    { icon: Send, color: '#2563eb', title: 'Send files', text: 'Email or link, see who downloaded', onClick: () => go('transfers') },
    { icon: FilePen, color: '#7c3aed', title: 'Edit a PDF', text: 'Text, highlights, signatures', href: '/edit' },
    { icon: FileInput, color: '#059669', title: 'Request files', text: 'Collect documents from clients', onClick: () => go('requests') },
    { icon: Link2, color: '#f97316', title: 'Shorten a link', text: 'Short URL with a QR code', onClick: () => go('short-links') },
  ];
  const pct = o ? Math.min(100, Math.round((o.usage.storage_bytes / Math.max(1, o.limits.storage_bytes)) * 100)) : 0;
  return (
    <div className="ws-home">
      <section aria-labelledby="start">
        <h2 id="start" className="ws-h2">
          What would you like to do?
        </h2>
        <div className="ws-actions">
          {actions.map(({ icon: Icon, color, title, text, onClick, href }) => {
            const inner = (
              <>
                <span className="tile-icon" style={{ background: color }}>
                  <Icon size={24} aria-hidden="true" />
                </span>
                <span className="tile-title">{title}</span>
                <span className="tile-text">{text}</span>
              </>
            );
            return href ? (
              <Link key={title} href={href} className="tile">
                {inner}
              </Link>
            ) : (
              <button key={title} type="button" className="tile" onClick={onClick}>
                {inner}
              </button>
            );
          })}
        </div>
      </section>

      <div className="ws-cols">
        <section className="ws-card" aria-labelledby="recent">
          <div className="ws-card-head">
            <h2 id="recent">Recent transfers</h2>
            <button type="button" className="link-button" onClick={() => go('transfers')}>
              See all <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
          {!t ? (
            <Muted>Loading…</Muted>
          ) : recent.length ? (
            <ul className="ws-list">
              {recent.map((x: any) => (
                <li key={x.id}>
                  <button type="button" onClick={() => go('transfers', x.id)}>
                    <span className="ws-list-main">
                      <strong>{x.title}</strong>
                      <span className="muted">
                        {x.file_count} file{x.file_count === 1 ? '' : 's'} · {fmtBytes(x.total_bytes)} · {x.downloads} download{x.downloads === 1 ? '' : 's'}
                      </span>
                    </span>
                    <Badge state={x.status} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="ws-empty">
              <p>Nothing sent yet.</p>
              <button type="button" className="button primary" onClick={() => go('transfers')}>
                <Send size={16} aria-hidden="true" /> Send your first files
              </button>
            </div>
          )}
        </section>

        <section className="ws-card" aria-labelledby="plan">
          <div className="ws-card-head">
            <h2 id="plan">Your plan</h2>
            <span className="plan-pill">{o?.limits.persistent ? 'Business' : 'Free'}</span>
          </div>
          {o ? (
            <>
              <div className="storage">
                <div className="storage-row">
                  <span>Storage</span>
                  <span className="muted">
                    {fmtBytes(o.usage.storage_bytes)} of {fmtBytes(o.limits.storage_bytes)}
                  </span>
                </div>
                <div className="bar" role="meter" aria-label="Storage used" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${pct}%` }} />
                </div>
              </div>
              <ul className="plan-facts">
                <li>Files up to {fmtBytes(o.limits.max_file_bytes)} each</li>
                <li>Transfers kept up to {o.limits.max_retention_days} days</li>
                <li>
                  {fmtBytes(o.usage.bandwidth_bytes)} of {fmtBytes(o.limits.bandwidth_bytes_per_month)} downloaded this month
                </li>
              </ul>
            </>
          ) : (
            <Muted>Loading…</Muted>
          )}
        </section>
      </div>
    </div>
  );
}
