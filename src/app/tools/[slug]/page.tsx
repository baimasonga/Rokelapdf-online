import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { ToolRunner } from '@/components/tools/tool-runner';
import { ToolTile } from '@/components/tools/tool-tile';
import { TOOLS, toolBySlug } from '@/lib/tools/registry';
import { PAID_TOOLS, TRIAL_DAYS } from '@/lib/licensing';

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const tool = toolBySlug((await params).slug);
  return tool ? { title: tool.title, description: tool.description } : {};
}

export default async function ToolPage({ params }: { params: Params }) {
  const tool = toolBySlug((await params).slug);
  if (!tool) notFound();
  const related = [...TOOLS.filter((t) => t.group === tool.group && t.slug !== tool.slug), ...TOOLS.filter((t) => t.popular && t.group !== tool.group)].slice(
    0,
    4,
  );
  return (
    <>
      <Header />
      <main className="tool-page">
        <section className="tool-hero">
          <h1>{tool.title}</h1>
          <p>{tool.description}</p>
          {PAID_TOOLS[tool.slug] ? (
            <p className="tool-pro">
              <span className="tile-pro">Pro</span> Free for your first {TRIAL_DAYS} days with an account, then a yearly licence.
            </p>
          ) : null}
        </section>
        <ToolRunner slug={tool.slug} />
        <section className="tool-more" aria-labelledby="more-tools">
          <h2 id="more-tools">More tools</h2>
          <div className="tiles tool-tiles">
            {related.map((t) => (
              <ToolTile key={t.slug} t={t} />
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
