import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { ToolIcon } from '@/components/tools/icons';
import { ToolRunner } from '@/components/tools/tool-runner';
import { GROUPS, TOOLS, toolBySlug } from '@/lib/tools/registry';

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const tool = toolBySlug((await params).slug);
  return tool ? { title: tool.title, description: tool.description } : {};
}

export default async function ToolPage({ params }: { params: Params }) {
  const tool = toolBySlug((await params).slug);
  if (!tool) notFound();
  const group = GROUPS.find((g) => g.id === tool.group)!;
  const related = TOOLS.filter((t) => t.group === tool.group && t.slug !== tool.slug).slice(0, 4);
  return (
    <>
      <Header />
      <main className="landing">
        <section className="section tool-page">
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link href="/tools">Tools</Link>
            <ChevronRight size={14} aria-hidden="true" />
            <span>{group.title}</span>
          </nav>
          <div className="tool-head">
            <span className={`tool-icon ${tool.group}`}>
              <ToolIcon name={tool.icon} size={26} />
            </span>
            <div>
              <h1>{tool.title}</h1>
              <p className="lead">{tool.description}</p>
            </div>
          </div>
          <ToolRunner slug={tool.slug} />
        </section>
        {related.length > 0 && (
          <section className="section related">
            <h2>More {group.title.toLowerCase()} tools</h2>
            <div className="tool-grid">
              {related.map((t) => (
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
        )}
      </main>
      <SiteFooter />
    </>
  );
}
