import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Providers } from '@/components/providers';
import '@fontsource-variable/inter';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Rokela PDF Pro', template: '%s · Rokela PDF Pro' },
  description: 'Edit PDFs in your browser and share them securely with expiring links, short links and QR codes.',
  referrer: 'no-referrer',
  icons: { icon: '/brand/icon-32.png', apple: '/brand/apple-touch-icon.png' },
};
export const viewport: Viewport = { themeColor: '#041638', width: 'device-width', initialScale: 1 };

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
