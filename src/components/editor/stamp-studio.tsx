'use client';
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { Button, Modal } from '@/components/ui';
import { INKS, TEMPLATES, newStamp, type StampDesign, type StampShape } from '@/lib/stamp/design';
import { renderStamp } from '@/lib/stamp/render';
import { deleteStamp, loadStamps, upsertStamp } from '@/lib/stamp/store';

// The Stamp Studio: design a stamp (a company seal, "RECEIVED", "PAID"…), see a real-ink impression of it, keep it on
// this device, and pick it for the editor's Stamp tool. Stamps are never uploaded.

const SHAPES: Array<[StampShape, string]> = [
  ['round', 'Round seal'],
  ['rect', 'Rectangle'],
  ['oval', 'Oval'],
];
const LABELS: Record<StampShape, [string, string, string]> = {
  round: ['Text around the top', 'Words in the middle', 'Text around the bottom'],
  rect: ['Main word', 'Second line', 'Small line at the bottom'],
  oval: ['Main word', 'Second line', 'Small line at the bottom'],
};

export function StampStudio({ open, current, onClose, onUse }: { open: boolean; current?: StampDesign; onClose: () => void; onUse: (d: StampDesign) => void }) {
  const [saved, setSaved] = useState<StampDesign[]>([]);
  const [d, setD] = useState<StampDesign>(() => current ?? newStamp(TEMPLATES[0]!.design));
  const [seed, setSeed] = useState(1);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const list = loadStamps();
    setSaved(list);
    setD(current ?? list[0] ?? newStamp(TEMPLATES[0]!.design));
    setError(undefined);
  }, [open, current]);

  const preview = useMemo(() => {
    if (!open) return undefined;
    try {
      return renderStamp(d, { seed });
    } catch {
      return undefined;
    }
  }, [open, d, seed]);

  const set = <K extends keyof StampDesign>(k: K, v: StampDesign[K]) => setD((x) => ({ ...x, [k]: v }));
  const isSaved = saved.some((x) => x.id === d.id);
  const labels = LABELS[d.shape];
  const use = () => {
    if (!d.top.trim() && !d.middle.trim() && !d.bottom.trim() && !d.date) {
      setError('Write something on the stamp first.');
      return;
    }
    setSaved(upsertStamp(d));
    onUse(d);
  };

  return (
    <Modal open={open} onClose={onClose} title="Stamp Studio" className="studio-modal">
      <div className="studio">
        <aside className="studio-list" aria-label="Your stamps">
          {saved.length > 0 && (
            <>
              <p className="studio-head">Your stamps</p>
              {saved.map((s) => (
                <button key={s.id} type="button" className={s.id === d.id ? 'studio-pick on' : 'studio-pick'} onClick={() => setD(s)}>
                  <span className="studio-dot" style={{ background: s.ink }} /> {s.name}
                </button>
              ))}
            </>
          )}
          <p className="studio-head">New from a template</p>
          {TEMPLATES.map((t) => (
            <button key={t.key} type="button" className="studio-pick" onClick={() => setD(newStamp(t.design))}>
              <span className="studio-dot" style={{ background: t.design.ink }} /> {t.label}
            </button>
          ))}
        </aside>

        <div className="studio-main">
          <div className="studio-preview">
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element -- a local data: URL, nothing to optimize
              <img src={preview.src} alt={`Preview of the ${d.name} stamp`} />
            )}
            <button type="button" className="ghost studio-again" onClick={() => setSeed((n) => n + 1)}>
              <RefreshCw size={15} aria-hidden="true" /> Stamp again
            </button>
            <p className="muted studio-note">Every impression comes out a little different, like a real rubber stamp.</p>
          </div>

          <div className="studio-form">
            <label>
              Name
              <input value={d.name} maxLength={60} onChange={(e) => set('name', e.target.value)} />
            </label>
            <span className="seg" role="radiogroup" aria-label="Shape">
              {SHAPES.map(([v, label]) => (
                <button key={v} type="button" role="radio" aria-checked={d.shape === v} className={d.shape === v ? 'on' : ''} onClick={() => set('shape', v)}>
                  {label}
                </button>
              ))}
            </span>
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
            <div className="studio-inks" role="radiogroup" aria-label="Ink colour">
              {INKS.map((i) => (
                <button
                  key={i.hex}
                  type="button"
                  role="radio"
                  aria-checked={d.ink === i.hex}
                  aria-label={`${i.name} ink`}
                  title={`${i.name} ink`}
                  className={d.ink === i.hex ? 'swatch on' : 'swatch'}
                  style={{ background: i.hex }}
                  onClick={() => set('ink', i.hex)}
                />
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={d.date} onChange={(e) => set('date', e.target.checked)} /> Add today’s date
            </label>
            <label className="check">
              <input type="checkbox" checked={d.numbered} onChange={(e) => set('numbered', e.target.checked)} /> Number each stamp
              {d.numbered && (
                <>
                  , next is
                  <input
                    className="studio-next"
                    type="number"
                    min={0}
                    max={999999}
                    value={d.next}
                    aria-label="Next number"
                    onChange={(e) => set('next', Math.max(0, Math.min(999999, Math.floor(Number(e.target.value) || 0))))}
                  />
                </>
              )}
            </label>
            <label>
              Size on paper: {Math.round(d.sizeMm)} mm wide
              <input type="range" min={25} max={90} value={d.sizeMm} onChange={(e) => set('sizeMm', Number(e.target.value))} />
            </label>
            <label>
              Ink: {d.wear < 0.25 ? 'clean' : d.wear < 0.7 ? 'hand-stamped' : 'well used'}
              <input type="range" min={0} max={100} value={Math.round(d.wear * 100)} onChange={(e) => set('wear', Number(e.target.value) / 100)} />
            </label>
          </div>
        </div>
      </div>
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      <div className="studio-actions">
        {isSaved && (
          <Button
            kind="ghost"
            onClick={() => {
              const list = deleteStamp(d.id);
              setSaved(list);
              setD(list[0] ?? newStamp(TEMPLATES[0]!.design));
            }}
          >
            <Trash2 size={15} aria-hidden="true" /> Delete
          </Button>
        )}
        <span className="muted studio-private">Kept on this device only.</span>
        <Button kind="primary" onClick={use}>
          Use this stamp
        </Button>
      </div>
    </Modal>
  );
}
