import type { ReactNode } from 'react';
import { Header } from './header';
import { LegalFooter } from './legal-footer';
import { COMPANY } from '@/lib/company';

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <Header />
      <main className="legal-page">
        <h1>{title}</h1>
        <p className="muted">Effective {COMPANY.effectiveDate}</p>
        {children}
      </main>
      <footer className="site-footer">
        <LegalFooter />
      </footer>
    </>
  );
}
