import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Verification pages can show details an issuer published (for example a student number): never index them.
export const metadata: Metadata = { title: 'Verify a document', robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
