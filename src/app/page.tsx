import Link from 'next/link';
import { ArrowRight, BadgeCheck, Check, Globe2, Lock, Mail, Send } from 'lucide-react';
import { Header } from '@/components/header';
import { HomeHero } from '@/components/home-hero';
import { SiteFooter } from '@/components/site-footer';
import { ToolTile } from '@/components/tools/tool-tile';
import { TOOLS } from '@/lib/tools/registry';

/** The tools the home page leads with; the rest are one click away on /tools. */
const START = ['merge-pdf', 'split-pdf', 'compress-pdf', 'edit-pdf', 'sign-pdf', 'pdf-to-word', 'protect-pdf', 'jpg-to-pdf'];

export default function Home() {
  return (
    <>
      <Header tone="dark" />
      <main className="home">
        <HomeHero />

        <section className="home-tools" id="tools" aria-labelledby="start-tools">
          <div className="home-section-head">
            <h2 id="start-tools">Start with a tool</h2>
            <Link href="/tools" className="home-more">
              All {TOOLS.length} tools <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </div>
          <div className="tiles tool-tiles">
            {START.map((slug) => TOOLS.find((t) => t.slug === slug)!).map((t) => (
              <ToolTile key={t.slug} t={t} />
            ))}
          </div>
        </section>

        <section className="home-send">
          <div className="home-send-copy">
            <span className="kicker">
              <Send size={15} aria-hidden="true" /> Rokela Send
            </span>
            <h2>Send big files. See who downloaded them.</h2>
            <ul className="ticks">
              <li>
                <Check size={18} aria-hidden="true" /> Email a personal link to each person, or get one link to share
              </li>
              <li>
                <Check size={18} aria-hidden="true" /> Passwords, expiry dates and download limits
              </li>
              <li>
                <Check size={18} aria-hidden="true" /> Recipients preview files and download everything as one ZIP
              </li>
            </ul>
            <Link href="/send" className="button primary xl">
              Send files <ArrowRight size={20} aria-hidden="true" />
            </Link>
          </div>
          <div className="home-send-art" aria-hidden="true">
            <div className="art-card">
              <div className="art-file">
                <span className="art-dot" style={{ background: '#ef4444' }} />
                Contract-final.pdf <em>2.4 MB</em>
              </div>
              <div className="art-file">
                <span className="art-dot" style={{ background: '#0ea5e9' }} />
                Site-photos.zip <em>184 MB</em>
              </div>
              <div className="art-chip">
                <Mail size={14} /> ama@client.com
              </div>
              <div className="art-btn">Transfer</div>
            </div>
            <div className="art-toast">
              <BadgeCheck size={18} /> Ama downloaded your files
            </div>
          </div>
        </section>

        <section className="home-why" aria-label="Why Rokela">
          <div>
            <Lock size={26} aria-hidden="true" />
            <h3>Private by design</h3>
            <p>
              PDF tools run on your device. Office conversions are deleted from our server the moment they finish, and files you send are stored privately until
              the transfer expires.
            </p>
          </div>
          <div>
            <BadgeCheck size={26} aria-hidden="true" />
            <h3>Free tools, no watermarks</h3>
            <p>
              Most tools need no account. Pro tools (editing, signing, OCR, password protection, splitting and merging) are free for your first month, then a
              yearly licence. Your documents come out exactly as you made them.
            </p>
          </div>
          <div>
            <Globe2 size={26} aria-hidden="true" />
            <h3>Works everywhere</h3>
            <p>Any modern browser on Windows, Mac, Linux, Android or iPhone. Nothing to install.</p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
