import Link from 'next/link';
import type { ToolDef } from '@/lib/tools/registry';
import { PAID_TOOLS } from '@/lib/licensing';
import { ToolIcon } from './icons';

/** One tool card: the tool's colour, icon, name and a one-line description; paid tools (src/lib/licensing.ts) say Pro. */
export function ToolTile({ t }: { t: ToolDef }) {
  return (
    <Link href={`/tools/${t.slug}`} className="tile">
      <span className="tile-icon" style={{ background: t.color }}>
        <ToolIcon name={t.icon} size={26} />
      </span>
      {PAID_TOOLS[t.slug] ? <span className="tile-pro">Pro</span> : null}
      <span className="tile-title">{t.title}</span>
      <span className="tile-text">{t.short}</span>
    </Link>
  );
}
