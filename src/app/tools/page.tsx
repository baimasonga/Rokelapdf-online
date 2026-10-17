import type { Metadata } from 'next';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { ToolGrid } from '@/components/tools/tool-grid';

export const metadata: Metadata = {
  title: 'All PDF tools',
  description: 'Free PDF tools that run in your browser: merge, split, rotate, crop, watermark, number pages, sign, fill forms and convert to images.',
};

export default function ToolsPage() {
  return (
    <>
      <Header />
      <main className="landing">
        <section className="section tools-intro">
          <h1>All PDF tools</h1>
          <p className="lead">Every tool runs in your browser — your files are never uploaded unless you choose to share them.</p>
          <ToolGrid />
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
