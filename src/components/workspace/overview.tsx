'use client';
import Link from 'next/link';
import { Check, FileInput, FilePen, Link2, Minus, Send } from 'lucide-react';
import { Muted, Panel } from '@/components/ui';
import { api } from '@/lib/client/api';
import { fmtBytes } from '@/lib/client/format';
import { useLoad, useWs } from './context';

/* eslint-disable @typescript-eslint/no-explicit-any */
function Stat({ label, used, limit, fmt = fmtBytes }: { label: string; used: number; limit: number; fmt?: (n: number) => string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {fmt(used)} <small>of {fmt(limit)}</small>
      </span>
      <meter min={0} max={limit} value={Math.min(used, limit)} aria-label={`${label}: ${fmt(used)} of ${fmt(limit)}`} />
    </div>
  );
}

export function Overview() {
  const { P, go } = useWs();
  const { data: o, error } = useLoad<any>(() => api(`${P}/overview`), [P]);
  const quick = [
    { icon: Send, title: 'Send files', text: 'Create a transfer', onClick: () => go('transfers') },
    { icon: FileInput, title: 'Request files', text: 'Collect from anyone', onClick: () => go('requests') },
    { icon: Link2, title: 'Shorten a link', text: 'Short URL + QR code', onClick: () => go('short-links') },
  ];
  const features: Array<[string, boolean | string]> = o
    ? [
        [`Files up to ${fmtBytes(o.limits.max_file_bytes)}`, true],
        [`Temporary sharing up to ${o.limits.max_retention_days} days`, true],
        ['Persistent sharing', o.limits.persistent],
        ['Upload requests', o.limits.upload_requests],
        ['Branded pages', o.limits.branding],
        ['Custom domains', o.limits.custom_domains],
        ['Advanced analytics', o.limits.advanced_analytics],
      ]
    : [];
  return (
    <>
      <div className="quick-actions">
        <Link href="/edit" className="quick">
          <span className="tool-icon">
            <FilePen size={20} aria-hidden="true" />
          </span>
          <span>
            <strong>Edit a PDF</strong>
            <small>Open the editor</small>
          </span>
        </Link>
        {quick.map(({ icon: Icon, title, text, onClick }) => (
          <button key={title} type="button" className="quick" onClick={onClick}>
            <span className="tool-icon amber">
              <Icon size={20} aria-hidden="true" />
            </span>
            <span>
              <strong>{title}</strong>
              <small>{text}</small>
            </span>
          </button>
        ))}
      </div>
      {error ? (
        <Panel title="Usage">{error.message}</Panel>
      ) : !o ? (
        <Muted>Loading…</Muted>
      ) : (
        <>
          <Panel title={`Usage this month · ${o.period}`}>
            <div className="stat-grid">
              <Stat label="Storage" used={o.usage.storage_bytes} limit={o.limits.storage_bytes} />
              <Stat label="Bandwidth" used={o.usage.bandwidth_bytes} limit={o.limits.bandwidth_bytes_per_month} />
              <Stat label="Processing" used={o.usage.processing_bytes} limit={o.limits.processing_bytes_per_month} />
              <Stat label="API changes" used={o.usage.api_requests} limit={o.limits.api_requests_per_month} fmt={(n) => n.toLocaleString()} />
            </div>
            <p className="fine-print">Bandwidth counts the size of each file delivered through a download link; it is an estimate of transfer volume.</p>
          </Panel>
          <Panel title="Your plan">
            <ul className="feature-list">
              {features.map(([label, on]) => (
                <li key={label} className={on ? 'yes' : 'no'}>
                  {on ? <Check size={16} aria-hidden="true" /> : <Minus size={16} aria-hidden="true" />} {label}
                  <span className="sr-only">{on ? ' (included)' : ' (not included)'}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
      <Panel title="What sharing controls can and cannot do" className="honest">
        <p>View-only access cannot prevent screenshots, photos of the screen or other copying.</p>
        <p>Revoking a link stops future access through it. It cannot remove copies that were already downloaded.</p>
        <p>A short URL is not access control. Confidential links use unpredictable codes; passwords, expiry and recipient restrictions protect the content.</p>
      </Panel>
    </>
  );
}
