import { useState, type ReactNode } from 'react';
import type { FormFieldInfo, CompressLevel } from '@/lib/tools/ops';

// Bottom sheets for the PDF tools: the "More" menu, compress, password, unlock and form filling.

export function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="sheet-title">{title}</h2>
        {children}
      </div>
    </>
  );
}

export interface MoreAction {
  label: string;
  hint?: string;
  run: () => void;
}

export function MoreSheet({ groups, onClose }: { groups: Array<[string, MoreAction[]]>; onClose: () => void }) {
  return (
    <Sheet title="More tools" onClose={onClose}>
      <div className="menu">
        {groups.map(([group, actions]) => (
          <section key={group}>
            <h3>{group}</h3>
            {actions.map((a) => (
              <button
                key={a.label}
                className="menu-item"
                onClick={() => {
                  onClose();
                  a.run();
                }}
              >
                <strong>{a.label}</strong>
                {a.hint ? <span>{a.hint}</span> : null}
              </button>
            ))}
          </section>
        ))}
      </div>
    </Sheet>
  );
}

const LEVELS: Array<[CompressLevel, string, string]> = [
  ['light', 'Light', 'Best quality, smaller file'],
  ['recommended', 'Recommended', 'Good quality, much smaller'],
  ['strong', 'Strong', 'Smallest file, lower picture quality'],
];

export function CompressSheet({ onClose, onPick }: { onClose: () => void; onPick: (level: CompressLevel) => void }) {
  return (
    <Sheet title="Compress PDF" onClose={onClose}>
      <p className="muted">Pictures and scans are made smaller. Text stays sharp.</p>
      {LEVELS.map(([level, label, hint]) => (
        <button key={level} className="menu-item" onClick={() => onPick(level)}>
          <strong>{label}</strong>
          <span>{hint}</span>
        </button>
      ))}
    </Sheet>
  );
}

export function ProtectSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (o: { password: string; allowPrinting: boolean; allowCopying: boolean; allowEditing: boolean }) => void;
}) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [allowPrinting, setPrinting] = useState(true);
  const [allowCopying, setCopying] = useState(false);
  const [allowEditing, setEditing] = useState(false);
  const short = password.length > 0 && password.length < 6;
  const mismatch = again.length > 0 && again !== password;
  return (
    <Sheet title="Protect with a password" onClose={onClose}>
      <label className="field">
        Password (at least 6 characters)
        <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="field">
        Type it again
        <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </label>
      {short ? <p className="error-inline">Use at least 6 characters.</p> : null}
      {mismatch ? <p className="error-inline">The passwords do not match.</p> : null}
      <label className="check">
        <input type="checkbox" checked={allowPrinting} onChange={(e) => setPrinting(e.target.checked)} /> Allow printing
      </label>
      <label className="check">
        <input type="checkbox" checked={allowCopying} onChange={(e) => setCopying(e.target.checked)} /> Allow copying text
      </label>
      <label className="check">
        <input type="checkbox" checked={allowEditing} onChange={(e) => setEditing(e.target.checked)} /> Allow changes
      </label>
      <p className="muted">Keep the password safe: nobody, including Rokela PDF, can open the file without it.</p>
      <div className="row">
        <span />
        <span className="actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={password.length < 6 || again !== password}
            onClick={() => onDone({ password, allowPrinting, allowCopying, allowEditing })}
          >
            Protect
          </button>
        </span>
      </div>
    </Sheet>
  );
}

export function UnlockSheet({ name, onClose, onDone }: { name: string; onClose: () => void; onDone: (password: string) => void }) {
  const [password, setPassword] = useState('');
  return (
    <Sheet title="This PDF is password-protected" onClose={onClose}>
      <p className="muted">Enter the password for {name}. Rokela PDF opens an unlocked copy; the original file is not changed.</p>
      <label className="field">
        Password
        <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <div className="row">
        <span />
        <span className="actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!password} onClick={() => onDone(password)}>
            Open
          </button>
        </span>
      </div>
    </Sheet>
  );
}

export function FormSheet({
  fields,
  onClose,
  onDone,
}: {
  fields: FormFieldInfo[];
  onClose: () => void;
  onDone: (values: Record<string, string | boolean>, flatten: boolean) => void;
}) {
  const editable = fields.filter((f) => !f.readOnly);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(editable.map((f) => [f.name, f.value])));
  const [flatten, setFlatten] = useState(false);
  const set = (name: string, v: string | boolean) => setValues((x) => ({ ...x, [name]: v }));
  return (
    <Sheet title="Fill in the form" onClose={onClose}>
      <div className="form-fields">
        {editable.map((f) => (
          <label key={f.name} className={f.type === 'checkbox' ? 'check' : 'field'}>
            {f.type === 'checkbox' ? (
              <>
                <input type="checkbox" checked={values[f.name] === true} onChange={(e) => set(f.name, e.target.checked)} /> {f.name}
              </>
            ) : (
              <>
                {f.name}
                {f.options.length ? (
                  <select value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)}>
                    <option value="">—</option>
                    {f.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : f.multiline ? (
                  <textarea rows={3} value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />
                ) : (
                  <input value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />
                )}
              </>
            )}
          </label>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} /> Lock the answers (they can no longer be changed)
      </label>
      <div className="row">
        <span />
        <span className="actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => onDone(values, flatten)}>
            Fill in
          </button>
        </span>
      </div>
    </Sheet>
  );
}
