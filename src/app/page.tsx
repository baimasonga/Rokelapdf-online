import Link from 'next/link';
import { Header } from '@/components/header';

const FEATURES: Array<[string, string]> = [
  ['Edit in the browser', 'Add text, highlight, draw, rotate, reorder, delete and merge pages. Your PDF is processed on your device.'],
  ['Share the right version', 'Share the latest published version or pin a link to one exact version. Drafts are never visible.'],
  ['Control every link', 'Expiry, download limits, passwords, named recipients, suspend, revoke — and replace files without changing the link.'],
  ['Short links and QR codes', 'Branded public links for campaigns; confidential links with unpredictable codes for documents.'],
  ['Request files', 'Send an upload link with a checklist and a deadline. Submitters only ever see their own files.'],
  ['Review and approve', 'Recipients comment and approve a version before you publish it.'],
];

export default function Home() {
  return (
    <>
      <Header />
      <main className="landing">
        <section className="hero">
          <h1>Edit, finish and share PDFs — safely.</h1>
          <p className="lead">
            Rokela PDF Pro is a browser PDF editor with file sharing built in: secure transfers, expiring links, short links, QR codes and upload requests, from
            one workspace.
          </p>
          <div className="actions">
            <Link href="/edit" className="button primary">
              Open the editor
            </Link>
            <Link href="/signin?mode=signup" className="button">
              Create a free account
            </Link>
          </div>
          <p className="muted">No account needed to edit and download. Sign in to save, share and collect files.</p>
        </section>
        <section className="features" aria-label="Features">
          {FEATURES.map(([t, d]) => (
            <article key={t} className="feature">
              <h2>{t}</h2>
              <p>{d}</p>
            </article>
          ))}
        </section>
        <section className="panel honest">
          <h2>What sharing controls can and cannot do</h2>
          <p>
            View-only access cannot prevent screenshots, photos of the screen or other copying. Revoking a link stops future access; it cannot recall copies
            already downloaded.
          </p>
        </section>
      </main>
      <footer className="site-footer">
        <span>© Rokela PDF Pro</span>
        <Link href="/report">Report abuse</Link>
      </footer>
    </>
  );
}
