import Link from 'next/link';
import { GROUPS, TOOLS, type ToolGroup } from '@/lib/tools/registry';
import { ToolIcon } from './icons';

/** All tools, grouped like a PDF tool site; each card links to the tool's own page. */
export function ToolGrid({ only }: { only?: ToolGroup }) {
  return (
    <>
      {GROUPS.filter((g) => !only || g.id === only).map((g) => (
        <section key={g.id} className="tool-section" aria-labelledby={`tools-${g.id}`}>
          <div className="section-head">
            <h2 id={`tools-${g.id}`}>{g.title}</h2>
            <p>{g.blurb}</p>
          </div>
          <div className="tool-grid">
            {TOOLS.filter((t) => t.group === g.id).map((t) => (
              <Link key={t.slug} href={`/tools/${t.slug}`} className="tool">
                <span className={`tool-icon ${t.group}`}>
                  <ToolIcon name={t.icon} />
                </span>
                <h3>{t.title}</h3>
                <p>{t.short}</p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
