import Link from 'next/link';
import { COMPANY } from '@/lib/company';

export function LegalFooter() {
  return (
    <div className="footer-base legal-footer">
      <span>
        {COMPANY.copyright}
        <small>Registered in {COMPANY.location}.</small>
      </span>
      <nav aria-label="Legal and contact">
        <Link href="/android">Android app</Link>
        <Link href="/ownership">Ownership</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <a href={`mailto:${COMPANY.email}`}>Contact</a>
        <Link href="/report">Report abuse</Link>
      </nav>
    </div>
  );
}
