import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { ToolDef } from '@/lib/tools/registry';
import { PAID_TOOLS } from '@/lib/licensing';
import { ToolIcon } from './icons';

/**
 * One tool: its icon in the tool's colour, its name, and paid tools (src/lib/licensing.ts) say Pro. A row with a
 * one-line description by default; `compact` is the name alone, for the All tools directory.
 */
export function ToolTile({ t, compact }: { t: ToolDef; compact?: boolean }) {
  return (
    <Link
      href={`/tools/${t.slug}`}
      className={compact ? 'tile tool-tile compact' : 'tile tool-tile'}
      style={{ '--tool': t.color } as CSSProperties}
      title={compact ? t.short : undefined}
    >
      <span className="tile-icon">
        <ToolIcon name={t.icon} size={compact ? 17 : 22} />
      </span>
      <span className="tile-title">{t.title}</span>
      {PAID_TOOLS[t.slug] ? <span className="tile-pro">Pro</span> : null}
      {compact ? null : <span className="tile-text">{t.short}</span>}
    </Link>
  );
}
