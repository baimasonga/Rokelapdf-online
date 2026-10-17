'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/lib/client/auth';

export function Brand({ href = '/' }: { href?: string }) {
  return (
    <Link href={href} className="brand" aria-label="Rokela PDF Pro home">
      <span className="logo" aria-hidden="true">
        R
      </span>
      <span>
        Rokela <strong>PDF Pro</strong>
      </span>
    </Link>
  );
}

export function Header({ minimal = false }: { minimal?: boolean }) {
  const { session, ready, signOut } = useAuth();
  const router = useRouter();
  return (
    <header className="site-header">
      <Brand />
      {!minimal && (
        <nav aria-label="Main">
          <Link href="/tools">Tools</Link>
          <Link href="/send">Send files</Link>
          <Link href="/edit">Editor</Link>
          {session && <Link href="/app">Files &amp; links</Link>}
          {ready &&
            (session ? (
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
            ) : (
              <>
                <Link href="/signin">Sign in</Link>
                <Link href="/signin?mode=signup" className="button primary">
                  Get started free
                </Link>
              </>
            ))}
        </nav>
      )}
    </header>
  );
}
