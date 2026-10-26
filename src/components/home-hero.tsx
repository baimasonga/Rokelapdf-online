'use client';
import Link from 'next/link';
import { useRef, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Check, FilePen, Layers, Loader2, Lock, ShieldCheck, Signature, Upload, WifiOff } from 'lucide-react';
import { putHandoff } from '@/lib/client/handoff';
import { TOOLS } from '@/lib/tools/registry';

/**
 * The home page's hero: a PDF chosen with the button, or dropped anywhere on the hero, opens straight in the editor
 * without being uploaded. Beside it, a picture of the product: a signed page, the editor's tools and the phone app.
 */
export function HomeHero() {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function open(file: File | undefined) {
    if (!file) return;
    setError(undefined);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-')) {
      setError(`“${file.name}” is not a PDF.`);
      return;
    }
    setBusy(true);
    try {
      await putHandoff(bytes, file.name);
      router.push('/edit?handoff=1');
    } catch {
      setBusy(false);
      setError('Your browser could not open the file here. Try the editor directly.');
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void open(e.dataTransfer.files[0]);
  };

  return (
    <section
      className={`hero-night${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="hero-grid">
        <div className="hero-copy">
          <span className="eyebrow">PDF tools · Made in Freetown</span>
          <h1>
            Every PDF task, <span className="nowrap">done</span> <em>beautifully.</em>
          </h1>
          <p className="hero-lead">
            Edit, sign, merge and convert documents in your browser or on your phone. No watermarks, nothing to install, and your files stay with you.
          </p>
          <div className="hero-ctas">
            <button type="button" className="button coral xl" disabled={busy} onClick={() => ref.current?.click()}>
              {busy ? <Loader2 size={20} className="spin" aria-hidden="true" /> : <Upload size={20} aria-hidden="true" />}
              {busy ? 'Opening…' : 'Choose a PDF'}
            </button>
            <Link href="/tools" className="hero-link">
              Explore all {TOOLS.length} tools
            </Link>
          </div>
          <p className="hero-drop-hint">
            <Lock size={13} aria-hidden="true" /> {over ? 'Drop the PDF to open it in the editor' : 'Or drop a PDF anywhere here to edit it'}
          </p>
          {error && (
            <p className="tool-error" role="alert">
              {error}
            </p>
          )}
          <ul className="hero-trust">
            <li>
              <ShieldCheck size={17} aria-hidden="true" /> Files stay on your device
            </li>
            <li>
              <Check size={17} aria-hidden="true" /> No watermarks
            </li>
            <li>
              <WifiOff size={17} aria-hidden="true" /> Works offline on Android
            </li>
          </ul>
          <input
            ref={ref}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              void open(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        <div className="hero-stage" aria-hidden="true">
          <div className="hero-sheet-back" />
          <div className="hero-sheet">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/home/document.webp" alt="" width={892} height={636} />
          </div>
          <div className="hero-toolbar">
            <span>
              <FilePen size={15} /> Text
            </span>
            <span>
              <Layers size={15} /> Highlight
            </span>
            <span className="on">
              <Signature size={15} /> Sign
            </span>
            <span>
              <Lock size={15} /> Protect
            </span>
          </div>
          <div className="hero-note">
            <span className="hero-note-tick">
              <Check size={15} />
            </span>
            <span>
              Signed by Aminata Kamara
              <small>Tenancy agreement.pdf · just now</small>
            </span>
          </div>
          <div className="hero-phone">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/home/phone-signed.webp" alt="" width={400} height={866} />
          </div>
        </div>
      </div>
      <dl className="hero-stats">
        <div>
          <dt>{TOOLS.length}</dt>
          <dd>PDF tools</dd>
        </div>
        <div>
          <dt>0</dt>
          <dd>watermarks</dd>
        </div>
        <div>
          <dt>100%</dt>
          <dd>in your browser</dd>
        </div>
        <div>
          <dt>
            <Link href="/android">Free</Link>
          </dt>
          <dd>
            <Link href="/android">Android app</Link>
          </dd>
        </div>
      </dl>
    </section>
  );
}
