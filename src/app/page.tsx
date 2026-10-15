import Link from 'next/link';
import {
  ArrowRight,
  Combine,
  FileInput,
  FilePen,
  Highlighter,
  Link2,
  Lock,
  QrCode,
  RotateCw,
  Send,
  ShieldCheck,
  Upload,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Header } from '@/components/header';

const TOOLS: Array<{ icon: LucideIcon; title: string; text: string; href: string; amber?: boolean }> = [
  { icon: FilePen, title: 'Edit PDF', text: 'Add text, boxes and freehand notes, right on the page.', href: '/edit' },
  { icon: Highlighter, title: 'Highlight & review', text: 'Mark up a document, then let others comment and approve.', href: '/edit' },
  { icon: Combine, title: 'Merge PDF', text: 'Combine several PDFs into one and put the pages in order.', href: '/edit' },
  { icon: RotateCw, title: 'Rotate & organize', text: 'Rotate, reorder, delete or insert blank pages.', href: '/edit' },
  { icon: Send, title: 'Send files', text: 'Share large files with expiring links and download limits.', href: '/signin?mode=signup', amber: true },
  { icon: Link2, title: 'Short links', text: 'Short, editable links for anything you publish.', href: '/signin?mode=signup', amber: true },
  { icon: QrCode, title: 'QR codes', text: 'A printable QR code for every short link.', href: '/signin?mode=signup', amber: true },
  { icon: FileInput, title: 'Request files', text: 'Collect documents from clients with a checklist and deadline.', href: '/signin?mode=signup', amber: true },
];

export default function Home() {
  return (
    <>
      <Header />
      <main className="landing">
        <section className="hero">
          <div className="hero-inner">
            <div>
              <div className="eyebrow">
                <Zap size={14} aria-hidden="true" /> PDF editor + secure sharing
              </div>
              <h1>
                Edit, finish and share PDFs — <em>safely.</em>
              </h1>
              <p className="lead">
                Edit PDFs in your browser, then send them with expiring links, short links and QR codes — or collect files from clients — all from one
                workspace.
              </p>
              <div className="actions">
                <Link href="/edit" className="button accent lg">
                  Open the editor <ArrowRight size={18} aria-hidden="true" />
                </Link>
                <Link href="/signin?mode=signup" className="button lg">
                  Create a free account
                </Link>
              </div>
              <p className="hero-note">
                <span>
                  <Lock size={14} aria-hidden="true" /> Files stay on your device while you edit
                </span>
                <span>
                  <ShieldCheck size={14} aria-hidden="true" /> No account needed to edit
                </span>
              </p>
            </div>
            <Link href="/edit" className="hero-drop" aria-label="Choose a PDF to edit">
              <span className="file-icon">
                <Upload size={30} aria-hidden="true" />
              </span>
              <strong>Choose a PDF</strong>
              <span className="muted">or drop it into the editor</span>
              <span className="button primary">Select file</span>
            </Link>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h2>Everything for your PDFs, in one place</h2>
            <p>Edit and organize documents, then share them with the right people — with control over every link.</p>
          </div>
          <div className="tool-grid">
            {TOOLS.map(({ icon: Icon, title, text, href, amber }) => (
              <Link key={title} href={href} className="tool">
                <span className={`tool-icon${amber ? ' amber' : ''}`}>
                  <Icon size={22} aria-hidden="true" />
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </Link>
            ))}
          </div>
        </section>

        <div className="band">
          <section className="section">
            <div className="section-head">
              <h2>From draft to delivered</h2>
              <p>Recipients only ever see what you publish.</p>
            </div>
            <div className="steps">
              <div className="step">
                <h3>Edit and save a draft</h3>
                <p>Drafts are private. Nothing is shared until you say so.</p>
              </div>
              <div className="step">
                <h3>Publish a version</h3>
                <p>Links follow the latest version, or stay pinned to one exact version.</p>
              </div>
              <div className="step">
                <h3>Share with control</h3>
                <p>Passwords, expiry, download limits and named recipients. Revoke at any time.</p>
              </div>
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
      <footer className="site-footer">
        <span>© Rokela PDF Pro</span>
        <Link href="/report">Report abuse</Link>
      </footer>
    </>
  );
}
