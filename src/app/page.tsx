import Link from 'next/link';
import { ArrowRight, BadgeCheck, Check, Globe2, Lock, Mail, Send } from 'lucide-react';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { HeroDrop } from '@/components/tools/hero-drop';
import { ToolBrowser } from '@/components/tools/tool-browser';

export default function Home() {
  return (
    <>
      <Header />
      <main className="home">
        <section className="home-hero">
          <h1>Every PDF tool you need, in one place</h1>
          <p className="home-lead">Merge, split, edit, sign and convert PDFs for free — right in your browser. No sign-up, no watermarks.</p>
          <HeroDrop />
        </section>

        <section className="home-tools" id="tools" aria-label="PDF tools">
          <ToolBrowser />
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
            <p>PDF tools run on your device. Files you send are stored privately and deleted when the transfer expires.</p>
          </div>
          <div>
            <BadgeCheck size={26} aria-hidden="true" />
            <h3>Free, no watermarks</h3>
            <p>Use every tool without an account. Your documents come out exactly as you made them.</p>
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
