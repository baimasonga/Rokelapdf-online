'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LegalFooter } from './legal-footer';
import { Brand } from './header';
import { Form, Panel } from './ui';
import { useAuth } from '@/lib/client/auth';

/** Frame for pages opened by recipients: minimal chrome, abuse reporting, and optional workspace branding. */
export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="public">
      <header className="site-header">
        <Brand />
      </header>
      <main>{children}</main>
      <footer className="site-footer">
        <LegalFooter />
      </footer>
    </div>
  );
}

/** Branding is display text and a validated colour from the API; it never replaces the Rokela frame. */
export function SenderBrand({ branding }: { branding?: { display_name: string; accent_color: string } | null }) {
  if (!branding) return null;
  return (
    <p className="sender" style={{ borderColor: /^#[0-9a-fA-F]{6}$/.test(branding.accent_color) ? branding.accent_color : undefined }}>
      Shared by <strong>{branding.display_name}</strong>
    </p>
  );
}

export function PasswordPrompt({ title, wrong, intro, onSubmit }: { title: string; wrong: boolean; intro: string; onSubmit: (pw: string) => unknown }) {
  return (
    <Panel title={title}>
      <p>{wrong ? 'That password was not correct.' : intro}</p>
      <Form
        fields={[{ name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' }]}
        submit="Open"
        onSubmit={(v) => onSubmit(v.password!)}
      />
    </Panel>
  );
}

export function SignInRequired({ next }: { next: string }) {
  const { session } = useAuth();
  return (
    <Panel title="Sign in to continue">
      {session ? (
        <p>
          This link is restricted to specific people. You are signed in as {session.user.email}, which does not have access. Ask the sender to share it with
          this address.
        </p>
      ) : (
        <>
          <p>This link is restricted to specific people. Sign in with the email address it was shared with.</p>
          <Link className="button primary" href={`/signin?next=${encodeURIComponent(next)}`}>
            Sign in
          </Link>
        </>
      )}
    </Panel>
  );
}
