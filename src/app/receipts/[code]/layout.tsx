import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Check pages show a business's receipt details and its customer's name: never index them.
export const metadata: Metadata = { title: 'Check a receipt', robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
