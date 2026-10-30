import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// A student's own fee claim, opened through a private link: never index it, never send it as a referrer.
export const metadata: Metadata = { title: 'Fee clearance status', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
