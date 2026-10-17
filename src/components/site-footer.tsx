import Link from 'next/link';
import { GROUPS, TOOLS } from '@/lib/tools/registry';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-cols">
        {GROUPS.map((g) => (
          <nav key={g.id} aria-label={g.title}>
            <h3>{g.title}</h3>
            {TOOLS.filter((t) => t.group === g.id).map((t) => (
              <Link key={t.slug} href={`/tools/${t.slug}`}>
                {t.title}
              </Link>
            ))}
          </nav>
        ))}
      </div>
      <div className="footer-base">
        <span>© Rokela PDF Pro</span>
        <Link href="/tools">All tools</Link>
        <Link href="/report">Report abuse</Link>
      </div>
    </footer>
  );
}
