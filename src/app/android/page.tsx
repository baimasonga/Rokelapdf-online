import type { Metadata } from 'next';
import { Check, Download, Smartphone } from 'lucide-react';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { ANDROID_APK, ANDROID_PAGE } from '@/lib/android';
import { encodeQr } from '@/lib/qr';

export const metadata: Metadata = {
  title: 'Rokela PDF for Android',
  description: 'Scan documents, open and sign PDFs, and convert Word ⇄ PDF on your Android phone.',
};

/** A QR code of this page, so people on a computer can open it on their phone. Drawn as SVG from fixed text. */
function PageQr() {
  const q = encodeQr(ANDROID_PAGE);
  const dim = q.size + 8;
  let d = '';
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y]![x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  return (
    <svg className="android-qr" viewBox={`0 0 ${dim} ${dim}`} shapeRendering="crispEdges" role="img" aria-label="QR code for rokelapdf.com/android">
      <rect width={dim} height={dim} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

const FEATURES = [
  'Scan documents with the camera: edges found and cleaned up automatically, saved as PDF',
  'Open PDFs from WhatsApp, Files or email with “Open with Rokela PDF”',
  'Sign PDFs with your finger; your signature never leaves the phone',
  'Convert Word to PDF and PDF to Word (needs internet and a free account)',
  'Save to any folder or share to WhatsApp, Drive and email',
];

export default function AndroidPage() {
  return (
    <>
      <Header />
      <main className="android-page">
        <section className="android-hero">
          <div>
            <span className="kicker">
              <Smartphone size={15} aria-hidden="true" /> Android app · test version
            </span>
            <h1>Rokela PDF for Android</h1>
            <ul className="ticks">
              {FEATURES.map((f) => (
                <li key={f}>
                  <Check size={18} aria-hidden="true" /> {f}
                </li>
              ))}
            </ul>
            <a href={ANDROID_APK} className="button primary xl" download>
              <Download size={20} aria-hidden="true" /> Download for Android
            </a>
            <p className="android-small">Free · about 7 MB · Android 7.0 or newer</p>
          </div>
          <div className="android-scan">
            <PageQr />
            <p>On a computer? Scan this with your phone’s camera to open this page there.</p>
          </div>
        </section>

        <section className="android-steps">
          <h2>How to install</h2>
          <ol>
            <li>
              Tap <strong>Download for Android</strong> on your phone. If your browser warns that the file might be harmful, choose{' '}
              <strong>Download anyway</strong>.
            </li>
            <li>
              Open the downloaded <strong>rokela-pdf.apk</strong> from the notification or your Downloads folder.
            </li>
            <li>
              Android asks for permission to install apps from your browser the first time: tap <strong>Settings</strong>, turn on{' '}
              <strong>Allow from this source</strong>, go back and tap <strong>Install</strong>.
            </li>
            <li>Open Rokela PDF from your home screen.</li>
          </ol>
          <p className="muted">
            This is a test version that is not yet on Google Play, which is why Android asks for permission. To update, download it again from this page. If
            Android says the app was not installed, uninstall the old version first and install again.
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
