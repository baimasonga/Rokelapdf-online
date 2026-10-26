import type { Metadata } from 'next';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { ReceiptMaker } from '@/components/receipts/receipt-maker';
import { TRIAL_DAYS } from '@/lib/licensing';

export const metadata: Metadata = {
  title: 'Receipt Maker: receipts, invoices and quotations',
  description:
    'Make cash receipts, sales invoices and proforma invoices for your business in Leones: receipt-book or modern style, A4 or A5, with your logo, stamp and signature, amount in words and mobile money details.',
};

export default function ReceiptsPage() {
  return (
    <>
      <Header />
      <main className="rk-page">
        <section className="tool-hero">
          <h1>Receipt Maker</h1>
          <p>Cash receipts, invoices and quotations for your business: your logo, stamp and signature, the amount in words, and mobile money details.</p>
          <p className="tool-pro">
            <span className="tile-pro">Pro</span> Free for your first {TRIAL_DAYS} days with an account, then a yearly licence.
          </p>
        </section>
        <ReceiptMaker />
      </main>
      <SiteFooter />
    </>
  );
}
