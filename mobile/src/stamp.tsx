import { useMemo, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { INKS, TEMPLATES, newStamp, type StampDesign, type StampShape } from '@/lib/stamp/design';
import { renderStamp } from '@/lib/stamp/render';
import { deleteStamp, loadStamps, upsertStamp } from '@/lib/stamp/store';
import { Sheet } from './ui';

// The Stamp Studio on the phone: the website's stamp designs and real-ink impressions (src/lib/stamp), in a bottom
// sheet. Stamps are kept on the phone; the editor's Stamp tool places a fresh impression with every tap.

const SHAPES: Array<[StampShape, string]> = [
  ['round', 'Round'],
  ['rect', 'Rectangle'],
  ['oval', 'Oval'],
];
const LABELS: Record<StampShape, [string, string, string]> = {
  round: ['Text around the top', 'Words in the middle', 'Text around the bottom'],
  rect: ['Main word', 'Second line', 'Small line at the bottom'],
  oval: ['Main word', 'Second line', 'Small line at the bottom'],
};

export function StampSheet({ current, onCancel, onUse }: { current?: StampDesign; onCancel: () => void; onUse: (d: StampDesign) => void }) {
  const [saved, setSaved] = useState<StampDesign[]>(loadStamps);
  const [d, setD] = useState<StampDesign>(() => current ?? saved[0] ?? newStamp(TEMPLATES[0]!.design));
  const [seed, setSeed] = useState(1);
  const [error, setError] = useState<string>();
  const preview = useMemo(() => {
    try {
      return renderStamp(d, { seed });
    } catch {
      return undefined;
    }
  }, [d, seed]);
  const set = <K extends keyof StampDesign>(k: K, v: StampDesign[K]) => setD((x) => ({ ...x, [k]: v }));
  const labels = LABELS[d.shape];
  const isSaved = saved.some((x) => x.id === d.id);

  return (
    <Sheet title="Stamp" onClose={onCancel}>
      <div className="stamp-picks" role="list" aria-label="Stamps">
        {saved.map((s) => (
          <button key={s.id} role="listitem" className={`stamp-pick${s.id === d.id ? ' on' : ''}`} onClick={() => setD(s)}>
            <span style={{ background: s.ink }} /> {s.name}
          </button>
        ))}
        {TEMPLATES.map((t) => (
          <button key={t.key} role="listitem" className="stamp-pick new" onClick={() => setD(newStamp(t.design))}>
            <span style={{ background: t.design.ink }} /> New: {t.label}
          </button>
        ))}
      </div>
      <div className="stamp-preview">
        {preview ? <img src={preview.src} alt={`Preview of the ${d.name} stamp`} /> : null}
        <button className="link" onClick={() => setSeed((n) => n + 1)}>
          <RefreshCw size={15} aria-hidden="true" /> Stamp again
        </button>
      </div>
      <div className="form-fields stamp-form">
        <label>
          Name
          <input value={d.name} maxLength={60} onChange={(e) => set('name', e.target.value)} />
        </label>
        <div className="seg" role="radiogroup" aria-label="Shape">
          {SHAPES.map(([v, label]) => (
            <button key={v} role="radio" aria-checked={d.shape === v} className={d.shape === v ? 'on' : ''} onClick={() => set('shape', v)}>
              {label}
            </button>
          ))}
        </div>
        <label>
          {labels[0]}
          <input value={d.top} maxLength={60} onChange={(e) => set('top', e.target.value)} />
        </label>
        <label>
          {labels[1]}
          <textarea rows={2} value={d.middle} maxLength={80} onChange={(e) => set('middle', e.target.value)} />
        </label>
        <label>
          {labels[2]}
          <input value={d.bottom} maxLength={60} onChange={(e) => set('bottom', e.target.value)} />
        </label>
        <span className="swatches" role="radiogroup" aria-label="Ink colour">
          {INKS.map((i) => (
            <button
              key={i.hex}
              role="radio"
              aria-checked={d.ink === i.hex}
              aria-label={`${i.name} ink`}
              className={`swatch${d.ink === i.hex ? ' on' : ''}`}
              style={{ background: i.hex }}
              onClick={() => set('ink', i.hex)}
            />
          ))}
        </span>
        <label className="check">
          <input type="checkbox" checked={d.date} onChange={(e) => set('date', e.target.checked)} /> Add today’s date
        </label>
        <label className="check">
          <input type="checkbox" checked={d.numbered} onChange={(e) => set('numbered', e.target.checked)} /> Number each stamp
        </label>
        {d.numbered ? (
          <label>
            Next number
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={999999}
              value={d.next}
              onChange={(e) => set('next', Math.max(0, Math.min(999999, Math.floor(Number(e.target.value) || 0))))}
            />
          </label>
        ) : null}
        <label>
          Size on paper: {Math.round(d.sizeMm)} mm wide
          <input type="range" min={25} max={90} value={d.sizeMm} onChange={(e) => set('sizeMm', Number(e.target.value))} />
        </label>
        <label>
          Ink: {d.wear < 0.25 ? 'clean' : d.wear < 0.7 ? 'hand-stamped' : 'well used'}
          <input type="range" min={0} max={100} value={Math.round(d.wear * 100)} onChange={(e) => set('wear', Number(e.target.value) / 100)} />
        </label>
        <label>
          Rough edges
          <input type="range" min={0} max={100} value={Math.round((d.edgeWear ?? 0) * 100)} onChange={(e) => set('edgeWear', Number(e.target.value) / 100)} />
        </label>
      </div>
      {error ? <p className="error-inline">{error}</p> : null}
      <div className="row">
        {isSaved ? (
          <button
            className="ghost pill"
            onClick={() => {
              const list = deleteStamp(d.id);
              setSaved(list);
              setD(list[0] ?? newStamp(TEMPLATES[0]!.design));
            }}
          >
            <Trash2 size={16} aria-hidden="true" /> Delete
          </button>
        ) : (
          <span className="muted">Kept on this phone.</span>
        )}
        <button
          className="primary pill"
          onClick={() => {
            if (!d.top.trim() && !d.middle.trim() && !d.bottom.trim() && !d.date) return setError('Write something on the stamp first.');
            setSaved(upsertStamp(d));
            onUse(d);
          }}
        >
          Use this stamp
        </button>
      </div>
    </Sheet>
  );
}
