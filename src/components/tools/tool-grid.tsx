import { GROUPS, TOOLS, type ToolGroup } from '@/lib/tools/registry';
import { ToolTile } from './tool-tile';

/** All tools, grouped by category; each card links to the tool's own page. */
export function ToolGrid({ only }: { only?: ToolGroup }) {
  return (
    <>
      {GROUPS.filter((g) => !only || g.id === only).map((g) => (
        <section key={g.id} className="tool-section" aria-labelledby={`tools-${g.id}`}>
          <h2 id={`tools-${g.id}`}>{g.title}</h2>
          <div className="tiles">
            {TOOLS.filter((t) => t.group === g.id).map((t) => (
              <ToolTile key={t.slug} t={t} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
