'use client';
import { useState } from 'react';
import { GROUPS, TOOLS, type ToolGroup } from '@/lib/tools/registry';
import { ToolTile } from './tool-tile';

/** The home page's tool grid with category filters, like the big PDF tool sites. */
export function ToolBrowser() {
  const [group, setGroup] = useState<ToolGroup | 'all'>('all');
  const shown = TOOLS.filter((t) => group === 'all' || t.group === group);
  return (
    <>
      <div className="chips-filter" role="tablist" aria-label="Tool categories">
        {[{ id: 'all' as const, title: 'All' }, ...GROUPS].map((g) => (
          <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className={group === g.id ? 'on' : ''} onClick={() => setGroup(g.id)}>
            {g.title}
          </button>
        ))}
      </div>
      <div className="tiles">
        {shown.map((t) => (
          <ToolTile key={t.slug} t={t} />
        ))}
      </div>
    </>
  );
}
