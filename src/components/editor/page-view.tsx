'use client';
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import {
  ASCENT,
  LINE_HEIGHT,
  boxFrom,
  displaySize,
  moveAnnot,
  toDisplay,
  toPage,
  type Annot,
  type BoxAnnot,
  type FieldAnnot,
  type InkAnnot,
  type Rotation,
} from '@/lib/editor/model';

export interface PageInfo {
  /** Unrotated visible size in points. */
  w: number;
  h: number;
  /** /Rotate of the source page. */
  base: Rotation;
}
export type Tool = 'select' | 'text' | 'highlight' | 'rect' | 'whiteout' | 'ink' | 'signature' | 'field';
/** A signature ready to place: PNG data URL and its width / height. */
export interface Signature {
  src: string;
  aspect: number;
}

/** Renders one page to a canvas when it scrolls into view. */
function PageCanvas({ doc, index, scale, rotation, w, h }: { doc: PDFDocumentProxy; index: number; scale: number; rotation: Rotation; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setVisible(true), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | undefined;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(index + 1);
      if (cancelled || !ref.current) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: scale * dpr, rotation });
      const canvas = ref.current;
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      delete canvas.dataset['rendered'];
      task = page.render({ canvas, viewport: vp });
      try {
        await task.promise;
        canvas.dataset['rendered'] = '1';
      } catch (e) {
        // A cancelled render (zoom, rotate, unmount) is expected; anything else is reported.
        if ((e as Error)?.name !== 'RenderingCancelledException') {
          canvas.dataset['renderError'] = String((e as Error)?.message ?? e).slice(0, 200);
          console.error('page render failed', e);
        }
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index, scale, rotation, visible]);
  const d = displaySize(w, h, rotation);
  return <canvas ref={ref} className="page-canvas" style={{ width: d.w * scale, height: d.h * scale }} aria-hidden="true" />;
}

/** Annotations drawn in display points (viewBox = shown page size). */
export function AnnotLayer({
  annots,
  info,
  total,
  selected,
  preview,
}: {
  annots: Annot[];
  info: PageInfo;
  total: Rotation;
  selected?: string | undefined;
  preview?: Annot | undefined;
}) {
  const d = displaySize(info.w, info.h, total);
  const pt = (x: number, y: number) => {
    const p = toDisplay(x, y, total);
    return { x: p.u * d.w, y: p.v * d.h };
  };
  const render = (a: Annot, ghost = false) => {
    const common = { 'data-annot': ghost ? undefined : a.id, className: `annot${a.id === selected ? ' selected' : ''}` };
    if (a.kind === 'text') {
      const p = pt(a.x, a.y);
      const turn = (((total - a.rot) % 360) + 360) % 360;
      return (
        <text
          key={a.id}
          {...common}
          x={p.x}
          y={p.y}
          fontSize={a.size}
          fill={a.color}
          fontFamily="Helvetica, Arial, sans-serif"
          transform={turn ? `rotate(${turn} ${p.x} ${p.y})` : undefined}
        >
          {a.text.split('\n').map((line, i) => (
            <tspan key={i} x={p.x} y={p.y + a.size * (ASCENT + i * LINE_HEIGHT)}>
              {line || ' '}
            </tspan>
          ))}
        </text>
      );
    }
    if (a.kind === 'ink')
      return (
        <polyline
          key={a.id}
          {...common}
          points={a.points.map(([x, y]) => `${pt(x, y).x},${pt(x, y).y}`).join(' ')}
          fill="none"
          stroke={a.color}
          strokeWidth={a.width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    const p1 = pt(a.x, a.y);
    const p2 = pt(a.x + a.w, a.y + a.h);
    const r = { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), width: Math.abs(p2.x - p1.x), height: Math.abs(p2.y - p1.y) };
    if (a.kind === 'image') {
      // Upright in the view it was placed in, turned with any rotation added since.
      const turn = (((total - a.rot) % 360) + 360) % 360;
      const [w, h] = turn % 180 ? [r.height, r.width] : [r.width, r.height];
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      return (
        <g key={a.id} {...common}>
          <rect {...r} fill="transparent" />
          <image
            href={a.src}
            x={cx - w / 2}
            y={cy - h / 2}
            width={w}
            height={h}
            preserveAspectRatio="none"
            transform={turn ? `rotate(${turn} ${cx} ${cy})` : undefined}
          />
        </g>
      );
    }
    if (a.kind === 'field')
      return (
        <g key={a.id} {...common} className={`${common.className} field`}>
          <rect {...r} fill="rgb(219 234 254 / 55%)" stroke={a.color} strokeWidth={1} />
          {a.field === 'checkbox' ? (
            <path
              d={`M${r.x + r.width * 0.22} ${r.y + r.height * 0.52} l${r.width * 0.2} ${r.height * 0.2} l${r.width * 0.36} ${-r.height * 0.42}`}
              fill="none"
              stroke={a.color}
              strokeWidth={1.2}
            />
          ) : (
            <text
              x={r.x + 3}
              y={r.y + Math.min(r.height - 3, 11)}
              fontSize={Math.min(9, r.height * 0.7)}
              fill={a.color}
              fontFamily="Helvetica, Arial, sans-serif"
            >
              {a.name}
            </text>
          )}
        </g>
      );
    if (a.kind === 'highlight') return <rect key={a.id} {...common} {...r} fill={a.color} fillOpacity={0.35} style={{ mixBlendMode: 'multiply' }} />;
    if (a.kind === 'whiteout')
      return <rect key={a.id} {...common} {...r} fill="#ffffff" stroke={a.id === selected ? '#1e88e5' : '#d0d7de'} strokeDasharray="3 2" strokeWidth={0.5} />;
    return <rect key={a.id} {...common} {...r} fill="none" stroke={a.color} strokeWidth={1.5} />;
  };
  return (
    <svg className="annot-layer" viewBox={`0 0 ${d.w} ${d.h}`} preserveAspectRatio="none">
      {annots.map((a) => render(a))}
      {preview && render(preview, true)}
    </svg>
  );
}

interface PageViewProps {
  doc: PDFDocumentProxy;
  index: number;
  info: PageInfo;
  added: Rotation;
  annots: Annot[];
  scale: number;
  tool: Tool;
  color: string;
  fontSize: number;
  inkWidth: number;
  selected: string | undefined;
  editing: string | undefined;
  onSelect(id: string | undefined): void;
  onCreate(a: Annot): void;
  onChange(a: Annot, commit: boolean): void;
  onEditText(id: string): void;
  /** The signature tool was used before a signature was created. */
  onNeedSignature(): void;
  signature: Signature | undefined;
  fieldType: FieldAnnot['field'];
  label: string;
}

let seq = 0;
const nid = () => `a${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A page with its annotation layer and the pointer interactions for the active tool. */
export function PageView(p: PageViewProps) {
  const total = ((((p.info.base + p.added) % 360) + 360) % 360) as Rotation;
  const d = displaySize(p.info.w, p.info.h, total);
  const box = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Annot>();
  const drag = useRef<{
    start: { x: number; y: number };
    annot?: Annot;
    last?: { x: number; y: number };
    moved?: boolean;
    points?: Array<[number, number]>;
    click?: RPointerEvent;
  }>(undefined);

  const shown = (e: RPointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { u: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), v: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const at = (e: RPointerEvent) => {
    const { u, v } = shown(e);
    return toPage(u, v, total);
  };
  /** A page-space box of w × h display points centred on the click, kept on the page. */
  const boxAt = (e: RPointerEvent, w: number, h: number) => {
    const { u, v } = shown(e);
    const bw = Math.min(1, w / d.w);
    const bh = Math.min(1, h / d.h);
    const u0 = Math.min(1 - bw, Math.max(0, u - bw / 2));
    const v0 = Math.min(1 - bh, Math.max(0, v - bh / 2));
    return boxFrom(toPage(u0, v0, total), toPage(u0 + bw, v0 + bh, total));
  };

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || p.editing) return;
    const pos = at(e);
    const target = (e.target as Element).closest('[data-annot]');
    if (p.tool === 'select') {
      const id = target?.getAttribute('data-annot') ?? undefined;
      p.onSelect(id);
      const a = id ? p.annots.find((x) => x.id === id) : undefined;
      if (a) {
        drag.current = { start: pos, annot: a, last: pos };
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }
    if (p.tool === 'text') {
      e.preventDefault();
      const a: Annot = { id: nid(), kind: 'text', x: pos.x, y: pos.y, text: '', size: p.fontSize, color: p.color, rot: total };
      p.onCreate(a);
      p.onEditText(a.id);
      return;
    }
    if (p.tool === 'signature') {
      e.preventDefault();
      if (!p.signature) return p.onNeedSignature();
      const w = Math.min(180, d.w * 0.35);
      p.onCreate({ id: nid(), kind: 'image', ...boxAt(e, w, w / p.signature.aspect), src: p.signature.src, rot: total, color: '#000000' });
      return;
    }
    if (p.tool === 'field' && p.fieldType === 'checkbox') {
      e.preventDefault();
      p.onCreate({ id: nid(), kind: 'field', field: 'checkbox', name: 'Checkbox', ...boxAt(e, 14, 14), color: p.color });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: pos, points: [[pos.x, pos.y]], click: e };
  };

  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g) return;
    const pos = at(e);
    if (g.annot) {
      const dx = pos.x - g.last!.x;
      const dy = pos.y - g.last!.y;
      g.last = pos;
      g.moved = true;
      const moved = moveAnnot(g.annot, dx, dy);
      g.annot = moved;
      p.onChange(moved, false);
      return;
    }
    if (p.tool === 'ink') {
      g.points!.push([pos.x, pos.y]);
      setPreview({ id: 'preview', kind: 'ink', points: [...g.points!], width: p.inkWidth, color: p.color } as InkAnnot);
      return;
    }
    const b = boxFrom(g.start, pos);
    if (p.tool === 'field') setPreview({ id: 'preview', kind: 'field', field: 'text', name: 'Text field', ...b, color: p.color });
    else setPreview({ id: 'preview', kind: p.tool as BoxAnnot['kind'], ...b, color: p.color });
  };

  const up = () => {
    const g = drag.current;
    drag.current = undefined;
    if (!g) return;
    if (g.annot) {
      if (g.moved) p.onChange(g.annot, true);
      return;
    }
    const pv = preview;
    setPreview(undefined);
    // A click (no drag) with the field tool adds a field of a typical size.
    const small = !pv || (pv.kind !== 'ink' && pv.kind !== 'text' && pv.kind !== 'image' && (pv.w * d.w <= 3 || pv.h * d.h <= 3));
    if (p.tool === 'field' && small && g.click) {
      p.onCreate({ id: nid(), kind: 'field', field: 'text', name: 'Text field', ...boxAt(g.click, 180, 22), color: p.color });
      return;
    }
    if (!pv) return;
    if (pv.kind === 'ink') {
      if (pv.points.length > 1) p.onCreate({ ...pv, id: nid() });
    } else if (pv.kind !== 'text' && pv.w * d.w > 3 && pv.h * d.h > 3) p.onCreate({ ...pv, id: nid() });
  };

  const editing = p.editing ? p.annots.find((a) => a.id === p.editing && a.kind === 'text') : undefined;
  return (
    <div className="page-wrap">
      <div
        ref={box}
        className={`page tool-${p.tool}`}
        style={{ width: d.w * p.scale, height: d.h * p.scale }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={(e) => {
          const id = (e.target as Element).closest('[data-annot]')?.getAttribute('data-annot');
          const a = id ? p.annots.find((x) => x.id === id) : undefined;
          if (a?.kind === 'text') p.onEditText(a.id);
        }}
        role="group"
        aria-label={p.label}
      >
        <PageCanvas doc={p.doc} index={p.index} scale={p.scale} rotation={total} w={p.info.w} h={p.info.h} />
        <AnnotLayer annots={p.annots.filter((a) => a.id !== editing?.id)} info={p.info} total={total} selected={p.selected} preview={preview} />
        {editing && editing.kind === 'text' && (
          <TextEditor a={editing} total={total} info={p.info} scale={p.scale} onDone={(t) => p.onChange({ ...editing, text: t }, true)} />
        )}
      </div>
    </div>
  );
}

function TextEditor({
  a,
  total,
  info,
  scale,
  onDone,
}: {
  a: Extract<Annot, { kind: 'text' }>;
  total: Rotation;
  info: PageInfo;
  scale: number;
  onDone(text: string): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(a.text);
  const done = useRef(false);
  const d = displaySize(info.w, info.h, total);
  const pos = toDisplay(a.x, a.y, total);
  const turn = (((total - a.rot) % 360) + 360) % 360;
  useEffect(() => ref.current?.focus(), []);
  const finish = (t: string) => {
    if (done.current) return;
    done.current = true;
    onDone(t);
  };
  const lines = text.split('\n');
  return (
    <textarea
      ref={ref}
      className="text-editor"
      aria-label="Text"
      value={text}
      rows={Math.max(1, lines.length)}
      cols={Math.max(8, ...lines.map((l) => l.length + 1))}
      style={{
        left: pos.u * d.w * scale,
        top: pos.v * d.h * scale,
        fontSize: a.size * scale,
        lineHeight: LINE_HEIGHT,
        color: a.color,
        transform: turn ? `rotate(${turn}deg)` : undefined,
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(text)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') finish(a.text);
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(text);
      }}
    />
  );
}

export function Thumb({ doc, index, info, added, annots }: { doc: PDFDocumentProxy; index: number; info: PageInfo; added: Rotation; annots: Annot[] }) {
  const total = ((((info.base + added) % 360) + 360) % 360) as Rotation;
  const scale = 110 / Math.max(info.w, info.h);
  const d = displaySize(info.w, info.h, total);
  return (
    <div className="thumb-page" style={{ width: d.w * scale, height: d.h * scale }}>
      <PageCanvas doc={doc} index={index} scale={scale} rotation={total} w={info.w} h={info.h} />
      <AnnotLayer annots={annots} info={info} total={total} />
    </div>
  );
}
