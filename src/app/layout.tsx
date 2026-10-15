import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Rokela PDF Pro', template: '%s · Rokela PDF Pro' },
  description: 'Edit PDFs in your browser and share them securely with expiring links, short links and QR codes.',
  referrer: 'no-referrer',
};
export const viewport: Viewport = { themeColor: '#0f3d3e', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request headers makes every page dynamic, so Next applies the per-request CSP nonce.
  await headers();
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
