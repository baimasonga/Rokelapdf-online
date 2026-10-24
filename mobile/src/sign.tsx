import { useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildPdf } from '@/lib/editor/export';
import { norm } from '@/lib/editor/model';
import { signatureEdits, trimSignature, typedSignature, type Placement, type SignatureImage } from '@/lib/editor/signature';

// Signing on the phone: the signature is drawn or typed here, placed on pages by touch, and drawn into the PDF on the
// device with the web editor's export. Nothing is uploaded.

export interface Placed extends Placement {
  id: number;
  aspect: number;
}

/** Draws every placed signature into the PDF and returns the signed copy. */
export async function signPdf(bytes: Uint8Array, doc: PDFDocumentProxy, placed: readonly Placed[]): Promise<Uint8Array> {
  const rotations = await Promise.all(Array.from({ length: doc.numPages }, async (_, i) => norm((await doc.getPage(i + 1)).rotate)));
  return buildPdf([bytes], signatureEdits(rotations, placed));
}

const INK = ['#111827', '#1d4ed8'];
const FONTS: Array<[string, string]> = [
  ['Handwriting', "'Dancing Script', 'Segoe Script', 'Brush Script MT', cursive"],
  ['Classic', "Georgia, 'Times New Roman', serif"],
];
const W = 900;
const H = 320;

export function SignaturePad({ onCancel, onDone }: { onCancel: () => void; onDone: (s: SignatureImage) => void }) {
  const [mode, setMode] = useState<'draw' | 'type'>('draw');
  const [ink, setInk] = useState(INK[0]!);
  const [name, setName] = useState('');
  const [font, setFont] = useState(FONTS[0]![1]);
  const [drawn, setDrawn] = useState(false);
  const [error, setError] = useState<string>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number }>(undefined);

  const pos = (e: RPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const move = (e: RPointerEvent<HTMLCanvasElement>) => {
    const a = last.current;
    if (!a) return;
    const b = pos(e);
    const ctx = e.currentTarget.getContext('2d')!;
    Object.assign(ctx, { strokeStyle: ink, lineWidth: 5, lineCap: 'round', lineJoin: 'round' });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    last.current = b;
    setDrawn(true);
  };
  const clear = () => {
    const c = canvas.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setDrawn(false);
  };
  const done = () => {
    const sig = mode === 'draw' ? (canvas.current ? trimSignature(canvas.current) : undefined) : typedSignature(name, font, ink);
    if (!sig) return setError(mode === 'draw' ? 'Draw your signature first.' : 'Type your name first.');
    onDone(sig);
  };

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Create your signature">
      <div className="seg" role="tablist">
        {(['draw', 'type'] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
            {m === 'draw' ? 'Draw' : 'Type'}
          </button>
        ))}
      </div>
      <div hidden={mode !== 'draw'}>
        <canvas
          ref={canvas}
          width={W}
          height={H}
          className="sig-canvas"
          aria-label="Sign here with your finger"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            last.current = pos(e);
          }}
          onPointerMove={move}
          onPointerUp={() => (last.current = undefined)}
          onPointerCancel={() => (last.current = undefined)}
        />
        <div className="row">
          <span className="muted">Sign with your finger.</span>
          <button className="link" onClick={clear} disabled={!drawn}>
            Clear
          </button>
        </div>
      </div>
      {mode === 'type' ? (
        <div className="sig-type">
          <input value={name} maxLength={60} placeholder="Your name" aria-label="Your name" onChange={(e) => setName(e.target.value)} />
          {FONTS.map(([label, f]) => (
            <button
              key={label}
              role="radio"
              aria-checked={font === f}
              className={`font${font === f ? ' on' : ''}`}
              style={{ fontFamily: f, color: ink }}
              onClick={() => setFont(f)}
            >
              {name.trim() || 'Your name'}
            </button>
          ))}
        </div>
      ) : null}
      <div className="row">
        <span className="swatches" role="radiogroup" aria-label="Ink colour">
          {INK.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={ink === c}
              aria-label={c === INK[0] ? 'Black ink' : 'Blue ink'}
              className={`swatch${ink === c ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => setInk(c)}
            />
          ))}
        </span>
        <span className="actions">
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={done}>
            Use signature
          </button>
        </span>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Signatures on one page while signing: tap to place, drag to move, drag the corner to resize, × to remove. */
export function SignLayer({
  page,
  placed,
  signature,
  onChange,
}: {
  page: number;
  placed: readonly Placed[];
  signature: SignatureImage;
  onChange: (next: Placed[] | ((old: Placed[]) => Placed[])) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; kind: 'move' | 'size'; x: number; y: number }>(undefined);
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const ratio = () => {
    const r = layer.current!.getBoundingClientRect();
    return r.width / r.height;
  };

  const place = (e: RMouseEvent<HTMLDivElement>) => {
    if (e.target !== layer.current) return;
    const r = layer.current.getBoundingClientRect();
    const w = 0.35;
    const h = (w * ratio()) / signature.aspect;
    const u = clamp((e.clientX - r.left) / r.width - w / 2, 0, 1 - w);
    const v = clamp((e.clientY - r.top) / r.height - h / 2, 0, Math.max(0, 1 - h));
    onChange((old) => [...old, { id: Date.now() + Math.random(), page, u, v, w, h, src: signature.src, aspect: signature.aspect }]);
  };
  const down = (e: RPointerEvent, id: number, kind: 'move' | 'size') => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { id, kind, x: e.clientX, y: e.clientY };
  };
  const move = (e: RPointerEvent) => {
    e.stopPropagation();
    const d = drag.current;
    if (!d) return;
    const r = layer.current!.getBoundingClientRect();
    const du = (e.clientX - d.x) / r.width;
    const dv = (e.clientY - d.y) / r.height;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    onChange((old) =>
      old.map((p) => {
        if (p.id !== d.id) return p;
        if (d.kind === 'move') return { ...p, u: clamp(p.u + du, 0, 1 - p.w), v: clamp(p.v + dv, 0, 1 - p.h) };
        const w = clamp(p.w + du, 0.08, 1 - p.u);
        const h = (w * (r.width / r.height)) / p.aspect;
        return p.v + h > 1 ? p : { ...p, w, h };
      }),
    );
  };
  const up = () => (drag.current = undefined);

  return (
    <div ref={layer} className="sign-layer" onClick={place}>
      {placed
        .filter((p) => p.page === page)
        .map((p) => (
          <div
            key={p.id}
            className="placed"
            style={{ left: `${p.u * 100}%`, top: `${p.v * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%` }}
            onPointerDown={(e) => down(e, p.id, 'move')}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          >
            <img src={p.src} alt="Your signature" draggable={false} />
            <button
              className="remove"
              aria-label="Remove signature"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onChange((old) => old.filter((x) => x.id !== p.id))}
            >
              ×
            </button>
            <span
              className="resize"
              aria-hidden="true"
              onPointerDown={(e) => down(e, p.id, 'size')}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
            />
          </div>
        ))}
    </div>
  );
}
