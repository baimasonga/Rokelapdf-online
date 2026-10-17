'use client';
import { useRef, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Lock, Upload } from 'lucide-react';
import { putHandoff } from '@/lib/client/handoff';

/** The home page's drop target: the chosen PDF opens straight in the editor, without being uploaded. */
export function HeroDrop() {
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
    <div
      className={`bigdrop${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <button type="button" className="button primary xl" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? <Loader2 size={22} className="spin" aria-hidden="true" /> : <Upload size={22} aria-hidden="true" />}
        {busy ? 'Opening…' : 'Choose PDF'}
      </button>
      <span className="bigdrop-hint">or drop a PDF here to edit it</span>
      <span className="bigdrop-note">
        <Lock size={13} aria-hidden="true" /> Files stay on your device
      </span>
      {error && (
        <span className="tool-error" role="alert">
          {error}
        </span>
      )}
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
  );
}
