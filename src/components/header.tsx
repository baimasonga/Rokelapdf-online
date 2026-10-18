'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, Menu, X } from 'lucide-react';
import { useAuth } from '@/lib/client/auth';
import { GROUPS, TOOLS } from '@/lib/tools/registry';
import { ToolIcon } from '@/components/tools/icons';

export function Brand({ href = '/' }: { href?: string }) {
  return (
    <Link href={href} className="brand" aria-label="Rokela PDF Pro home">
      <span className="logo" aria-hidden="true">
        R
      </span>
      <span>
        Rokela <strong>PDF</strong>
      </span>
    </Link>
  );
}

/** Every tool, grouped; used by the desktop "Tools" menu and the phone menu. */
function ToolsMenu({ onPick }: { onPick: () => void }) {
  return (
    <div className="mega-cols">
      {GROUPS.map((g) => (
        <div key={g.id} className="mega-col">
          <p className="mega-title">{g.title}</p>
          {TOOLS.filter((t) => t.group === g.id).map((t) => (
            <Link key={t.slug} href={`/tools/${t.slug}`} className="mega-link" onClick={onPick}>
              <span className="tile-icon sm" style={{ background: t.color }}>
                <ToolIcon name={t.icon} size={15} />
              </span>
              {t.title}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Header({ minimal = false }: { minimal?: boolean }) {
  const { session, ready, signOut } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const [tools, setTools] = useState(false);
  const [mobile, setMobile] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menus on navigation, outside clicks and Escape.
  useEffect(() => {
    setTools(false);
    setMobile(false);
  }, [path]);
  useEffect(() => {
    if (!tools && !mobile) return;
    const click = (e: MouseEvent) => {
      if (tools && menuRef.current && !menuRef.current.contains(e.target as Node)) setTools(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTools(false);
        setMobile(false);
      }
    };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', click);
      document.removeEventListener('keydown', key);
    };
  }, [tools, mobile]);

  const account =
    ready &&
    (session ? (
      <>
        <Link href="/app" className="nav-link">
          My files
        </Link>
        <button
          type="button"
          className="ghost"
          onClick={async () => {
            await signOut();
            router.push('/');
          }}
        >
          <LogOut size={16} aria-hidden="true" /> Sign out
        </button>
      </>
    ) : (
      <>
        <Link href="/signin" className="nav-link">
          Log in
        </Link>
        <Link href="/signin?mode=signup" className="button primary">
          Sign up free
        </Link>
      </>
    ));

  return (
    <header className="site-header">
      <Brand />
      {!minimal && (
        <>
          <nav aria-label="Main" className="nav-main">
            <div className="nav-tools" ref={menuRef}>
              <button
                type="button"
                className={`nav-link${tools ? ' open' : ''}`}
                aria-expanded={tools}
                aria-haspopup="true"
                onClick={() => setTools((v) => !v)}
              >
                All tools <ChevronDown size={15} aria-hidden="true" />
              </button>
              {tools && (
                <div className="mega" role="menu">
                  <ToolsMenu onPick={() => setTools(false)} />
                  <Link href="/tools" className="mega-all" onClick={() => setTools(false)}>
                    See all tools →
                  </Link>
                </div>
              )}
            </div>
            <Link href="/tools/merge-pdf" className="nav-link">
              Merge
            </Link>
            <Link href="/tools/split-pdf" className="nav-link">
              Split
            </Link>
            <Link href="/edit" className="nav-link">
              Edit
            </Link>
            <Link href="/tools/sign-pdf" className="nav-link">
              Sign
            </Link>
            <Link href="/shorten" className="nav-link">
              Shorten links
            </Link>
            <Link href="/send" className="nav-link">
              Send files
            </Link>
          </nav>
          <div className="nav-account">{account}</div>
          <button
            type="button"
            className="ghost nav-burger"
            aria-label={mobile ? 'Close menu' : 'Open menu'}
            aria-expanded={mobile}
            onClick={() => setMobile((v) => !v)}
          >
            {mobile ? <X size={22} /> : <Menu size={22} />}
          </button>
          {mobile && (
            <div className="mobile-menu">
              <div className="mobile-links">
                <Link href="/edit">Edit a PDF</Link>
                <Link href="/send">Send files</Link>
                <Link href="/shorten">Shorten links</Link>
                <Link href="/tools">All tools</Link>
              </div>
              <ToolsMenu onPick={() => setMobile(false)} />
              <div className="mobile-account">{account}</div>
            </div>
          )}
        </>
      )}
    </header>
  );
}
