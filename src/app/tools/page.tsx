import type { Metadata } from 'next';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { ToolGrid } from '@/components/tools/tool-grid';

export const metadata: Metadata = {
  title: 'All PDF tools',
  description: 'Free PDF tools: merge, split, compress, edit, sign, fill forms, OCR, and convert PDF to Word, Excel, PowerPoint and images — and back.',
};

export default function ToolsPage() {
  return (
    <>
      <Header />
      <main className="tool-page">
        <section className="tool-hero">
          <h1>All PDF tools</h1>
          <p>
            Most tools are free and need no account. Tools marked Pro are free for your first month, then need a yearly licence. PDF tools run in your browser,
            so those files are never uploaded; Word, Excel and PowerPoint conversions use our server with a free account and delete the file straight after.
          </p>
        </section>
        <div className="tools-all">
          <ToolGrid />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
