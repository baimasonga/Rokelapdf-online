import Link from 'next/link';
import type { ToolDef } from '@/lib/tools/registry';
import { ToolIcon } from './icons';

/** One tool card: the tool's colour, icon, name and a one-line description. */
export function ToolTile({ t }: { t: ToolDef }) {
  return (
    <Link href={`/tools/${t.slug}`} className="tile">
      <span className="tile-icon" style={{ background: t.color }}>
        <ToolIcon name={t.icon} size={26} />
      </span>
      <span className="tile-title">{t.title}</span>
      <span className="tile-text">{t.short}</span>
    </Link>
  );
}
