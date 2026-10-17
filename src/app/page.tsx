import Link from 'next/link';
import { ArrowRight, FileInput, Link2, Lock, QrCode, Send, ShieldCheck, Sparkles, Zap, type LucideIcon } from 'lucide-react';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { HeroDrop } from '@/components/tools/hero-drop';
import { ToolGrid } from '@/components/tools/tool-grid';
import { ToolIcon } from '@/components/tools/icons';
import { TOOLS } from '@/lib/tools/registry';

const SHARING: Array<{ icon: LucideIcon; title: string; text: string }> = [
  { icon: Send, title: 'Send files', text: 'Share large files with expiring links and download limits.' },
  { icon: Link2, title: 'Short links', text: 'Short, editable links for anything you publish.' },
  { icon: QrCode, title: 'QR codes', text: 'A printable QR code for every short link.' },
  { icon: FileInput, title: 'Request files', text: 'Collect documents from clients with a checklist and deadline.' },
];

export default function Home() {
  const popular = TOOLS.filter((t) => t.popular);
  return (
    <>
      <Header />
      <main className="landing">
        <section className="hero">
          <div className="hero-inner">
            <div>
              <div className="eyebrow">
                <Zap size={14} aria-hidden="true" /> {TOOLS.length} free PDF tools · no sign-up
              </div>
              <h1>
                Every PDF tool you need — <em>private by design.</em>
              </h1>
              <p className="lead">
                Edit, sign, merge, split, convert and organize PDFs right in your browser. Your files stay on your device; share them only when you choose.
              </p>
              <div className="hero-tools" aria-label="Popular tools">
                {popular.map((t) => (
                  <Link key={t.slug} href={`/tools/${t.slug}`} className="quick-tool">
                    <ToolIcon name={t.icon} size={16} /> {t.title}
                  </Link>
                ))}
              </div>
              <p className="hero-note">
                <span>
                  <Lock size={14} aria-hidden="true" /> Processed in your browser
                </span>
                <span>
                  <ShieldCheck size={14} aria-hidden="true" /> No watermarks, no account needed
                </span>
              </p>
            </div>
            <HeroDrop />
          </div>
        </section>

        <section className="section" id="tools">
          <ToolGrid />
        </section>

        <div className="band">
          <section className="section">
            <div className="section-head">
              <div className="eyebrow">
                <Sparkles size={14} aria-hidden="true" /> With a free account
              </div>
              <h2>Finished? Share it with control</h2>
              <p>Publish a version and send it with passwords, expiry and download limits — or collect files from clients. Revoke any link at any time.</p>
            </div>
            <div className="tool-grid">
              {SHARING.map(({ icon: Icon, title, text }) => (
                <Link key={title} href="/signin?mode=signup" className="tool">
                  <span className="tool-icon amber">
                    <Icon size={22} aria-hidden="true" />
                  </span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </Link>
              ))}
            </div>
            <div className="actions">
              <Link href="/signin?mode=signup" className="button accent lg">
                Create a free account <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </div>
          </section>
        </div>

        <section className="section">
          <div className="panel honest">
            <h2>What sharing controls can and cannot do</h2>
            <p>
              View-only access cannot prevent screenshots, photos of the screen or other copying. Revoking a link stops future access; it cannot recall copies
              already downloaded.
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
