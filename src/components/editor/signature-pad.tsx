'use client';
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Button, Modal } from '@/components/ui';
import type { Signature } from './page-view';
import { trimSignature as finish, typedSignature } from '@/lib/editor/signature';

// Creates a signature image on this device: drawn, typed or from a photo/scan. The result is a trimmed PNG with a
// transparent background; it is never uploaded and is forgotten when the editor closes.

type Mode = 'draw' | 'type' | 'upload';
const INK = ['#111827', '#1d4ed8'];
const FONTS: Array<[string, string]> = [
  ['Handwriting', "'Segoe Script', 'Brush Script MT', 'Snell Roundhand', 'URW Chancery L', cursive"],
  ['Elegant', "'Lucida Handwriting', 'Apple Chancery', 'Zapf Chancery', cursive"],
  ['Classic', "Georgia, 'Times New Roman', serif"],
];
const W = 640;
const H = 220;

export function SignaturePad({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (s: Signature) => void }) {
  const [mode, setMode] = useState<Mode>('draw');
  const [ink, setInk] = useState(INK[0]!);
  const [name, setName] = useState('');
  const [font, setFont] = useState(FONTS[0]![1]);
  const [error, setError] = useState<string>();
  const [drawn, setDrawn] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number }>(undefined);
  const upload = useRef<HTMLCanvasElement>(null);
  const [hasUpload, setHasUpload] = useState(false);

  const clear = () => {
    const c = canvas.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setDrawn(false);
  };
  useEffect(() => {
    if (!open) return;
    setError(undefined);
  }, [open]);

  const pos = (e: RPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const down = (e: RPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = pos(e);
  };
  const move = (e: RPointerEvent<HTMLCanvasElement>) => {
    const a = last.current;
    if (!a) return;
    const b = pos(e);
    const ctx = e.currentTarget.getContext('2d')!;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    last.current = b;
    setDrawn(true);
  };
  const up = () => (last.current = undefined);

  async function readImage(file: File | undefined) {
    if (!file) return;
    setError(undefined);
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(file);
    } catch {
      return setError('That file is not an image this browser can read.');
    }
    const c = upload.current!;
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    // Paper becomes transparent so the signature sits on the document, not in a white box.
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      if (lum > 200) d[i + 3] = 0;
      else if (lum > 150) d[i + 3] = Math.round((d[i + 3]! * (200 - lum)) / 50);
    }
    ctx.putImageData(img, 0, 0);
    setHasUpload(true);
  }

  function done() {
    let sig: Signature | undefined;
    if (mode === 'draw') sig = canvas.current ? finish(canvas.current) : undefined;
    else if (mode === 'upload') sig = hasUpload && upload.current ? finish(upload.current) : undefined;
    else sig = typedSignature(name, font, ink);
    if (!sig)
      return setError(mode === 'type' ? 'Type your name first.' : mode === 'upload' ? 'Choose an image of your signature.' : 'Draw your signature first.');
    onDone(sig);
  }

  return (
    <Modal open={open} onClose={onClose} title="Create your signature">
      <div className="seg" role="tablist" aria-label="Signature type">
        {(
          [
            ['draw', 'Draw'],
            ['type', 'Type'],
            ['upload', 'Upload'],
          ] as Array<[Mode, string]>
        ).map(([m, label]) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>
      <div className="sig-body">
        <div hidden={mode !== 'draw'}>
          <canvas
            ref={canvas}
            width={W}
            height={H}
            className="sig-canvas"
            aria-label="Draw your signature here"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
          <div className="sig-row">
            <span className="muted">Sign with your mouse, finger or stylus.</span>
            <Button kind="ghost" onClick={clear} disabled={!drawn}>
              Clear
            </Button>
          </div>
        </div>
        {mode === 'type' && (
          <div className="sig-type">
            <input value={name} maxLength={60} placeholder="Your name" aria-label="Your name" onChange={(e) => setName(e.target.value)} />
            <div className="sig-fonts" role="radiogroup" aria-label="Style">
              {FONTS.map(([label, f]) => (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={font === f}
                  className={font === f ? 'on' : ''}
                  style={{ fontFamily: f, color: ink }}
                  onClick={() => setFont(f)}
                >
                  {name.trim() || 'Your name'}
                </button>
              ))}
            </div>
          </div>
        )}
        <div hidden={mode !== 'upload'}>
          <label className="button file-button">
            Choose image
            <input type="file" accept="image/*" onChange={(e) => void readImage(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
          </label>
          <canvas ref={upload} className="sig-canvas" hidden={!hasUpload} aria-label="Uploaded signature" />
          <p className="muted">A photo or scan of your signature on white paper works best; the paper is removed automatically.</p>
        </div>
      </div>
      <div className="sig-row">
        <span className="swatches" role="radiogroup" aria-label="Ink colour">
          {INK.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={ink === c}
              aria-label={`Ink ${c}`}
              className={`swatch${ink === c ? ' active' : ''}`}
              style={{ background: c }}
              disabled={mode === 'upload'}
              onClick={() => setInk(c)}
            />
          ))}
        </span>
        <div className="actions">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" onClick={done}>
            Use signature
          </Button>
        </div>
      </div>
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
