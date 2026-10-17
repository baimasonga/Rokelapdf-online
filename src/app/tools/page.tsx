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
      <main className="tool-page">
        <section className="tool-hero">
          <h1>All PDF tools</h1>
          <p>Every tool is free and runs in your browser — your files are never uploaded.</p>
        </section>
        <div className="tools-all">
          <ToolGrid />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
