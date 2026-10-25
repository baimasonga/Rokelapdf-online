import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { FileText, Gauge, Feather, Zap } from 'lucide-react';
import { Row, Sheet, ToolTile, type ToolDef } from './ui';
import type { FormFieldInfo, CompressLevel, SplitMode } from '@/lib/tools/ops';
import { COMPANY } from '@/lib/company';
import { FEATURE_NAMES, TRIAL_DAYS, type PaidFeature } from '@/lib/licensing';
import type { Why } from './access';
import { PLAY_BUILD } from './account';
import { RECENT_MAX } from './recent';

// Bottom sheets for the PDF tools: all tools, compress, split, password, unlock, form filling and the Pro prompt.

/** "All tools" for the open PDF: a grid of tools, then quick actions (save, share). */
export function ToolsSheet({
  tools,
  actions,
  onClose,
}: {
  tools: ToolDef[];
  actions: Array<{ label: string; icon: LucideIcon; run: () => void }>;
  onClose: () => void;
}) {
  const close = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Sheet title="All tools" onClose={onClose}>
      <div className="tool-grid">
        {tools.map((t) => (
          <ToolTile key={t.id} tool={{ ...t, run: close(t.run) }} />
        ))}
      </div>
      <div className="sheet-rows">
        {actions.map((a) => (
          <Row key={a.label} icon={a.icon} title={a.label} onClick={close(a.run)} />
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
      <div className="sheet-rows">
        {LEVELS.map(([level, label, hint], i) => (
          <Row key={level} icon={[Feather, Gauge, Zap][i]!} iconColor="#e8890c" title={label} detail={hint} onClick={() => onPick(level)} />
        ))}
      </div>
    </Sheet>
  );
}

type SplitKind = SplitMode['kind'];
const SPLIT_KINDS: Array<[SplitKind, string]> = [
  ['each', 'Every page'],
  ['every', 'Every few pages'],
  ['ranges', 'Page ranges'],
];

/** Split into several PDFs: one per page, a fixed number of pages each, or ranges the person types. */
export function SplitSheet({ pages, onClose, onSplit }: { pages: number; onClose: () => void; onSplit: (mode: SplitMode) => void }) {
  const [kind, setKind] = useState<SplitKind>('each');
  const [n, setN] = useState('2');
  const [ranges, setRanges] = useState('');
  const every = Math.max(1, Math.floor(Number(n)) || 1);
  const files = kind === 'each' ? pages : kind === 'every' ? Math.ceil(pages / every) : undefined;
  const mode: SplitMode = kind === 'each' ? { kind } : kind === 'every' ? { kind, n: every } : { kind, spec: ranges };
  return (
    <Sheet title="Split PDF" onClose={onClose}>
      <p className="muted">Each part becomes its own PDF. This one has {pages === 1 ? '1 page' : `${pages} pages`}.</p>
      <div className="seg" role="tablist" aria-label="How to split">
        {SPLIT_KINDS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {label}
          </button>
        ))}
      </div>
      {kind === 'every' ? (
        <label className="field">
          Pages in each file
          <input type="number" inputMode="numeric" min={1} max={pages} value={n} onChange={(e) => setN(e.target.value)} />
        </label>
      ) : null}
      {kind === 'ranges' ? (
        <label className="field">
          Page ranges, one file each
          <input inputMode="numeric" placeholder="For example 1-2, 3, 4-6" value={ranges} onChange={(e) => setRanges(e.target.value)} />
        </label>
      ) : null}
      {files && files > RECENT_MAX ? (
        <p className="error-inline">
          That makes {files} files. Split into {RECENT_MAX} or fewer at a time, so every part is kept in Recent.
        </p>
      ) : null}
      <div className="row">
        <span className="muted">{files ? `Makes ${files === 1 ? '1 file' : `${files} files`}` : ''}</span>
        <span className="actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!!files && files > RECENT_MAX} onClick={() => onSplit(mode)}>
            Split
          </button>
        </span>
      </div>
    </Sheet>
  );
}

export interface Part {
  name: string;
  bytes: Uint8Array;
  pages: number;
}

/** The files a split made: open any of them, or share them all at once. */
export function PartsSheet({ parts, onOpen, onShareAll, onClose }: { parts: Part[]; onOpen: (p: Part) => void; onShareAll: () => void; onClose: () => void }) {
  return (
    <Sheet title={`Split into ${parts.length} files`} onClose={onClose}>
      <p className="muted">Tap a file to open it. They are all in Recent too.</p>
      <div className="sheet-rows">
        {parts.map((p) => (
          <Row
            key={p.name}
            icon={FileText}
            iconColor="#1e8a5a"
            title={p.name}
            detail={p.pages === 1 ? '1 page' : `${p.pages} pages`}
            onClick={() => onOpen(p)}
          />
        ))}
      </div>
      <div className="row">
        <span />
        <span className="actions">
          <button className="ghost" onClick={onClose}>
            Done
          </button>
          <button className="primary" onClick={onShareAll}>
            Share all
          </button>
        </span>
      </div>
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

/**
 * Shown when a paid tool (src/lib/licensing.ts) cannot be used yet: what to do about it. The Google Play build says a
 * licence is needed but not how to buy one (PLAY_BUILD).
 */
export function PaidSheet({ feature, why, onClose, onSignIn }: { feature: PaidFeature; why: Why; onClose: () => void; onSignIn: () => void }) {
  const mail = PLAY_BUILD ? null : `mailto:${COMPANY.email}?subject=${encodeURIComponent('Rokela PDF licence')}`;
  const text: Record<Why, string> = {
    signin: `Sign in to use it. Every new account gets ${TRIAL_DAYS} days of every Pro tool free.`,
    trial_ended: PLAY_BUILD
      ? 'Your free month has ended. The Pro tools need a Pro licence on your account.'
      : `Your free month has ended. A yearly licence keeps the Pro tools unlocked here and on rokelapdf.com. Email ${COMPANY.email} from the address you sign in with.`,
    license_ended: PLAY_BUILD
      ? 'Your Pro licence has ended.'
      : `Your licence has ended. Renew it to keep using the Pro tools: email ${COMPANY.email} from the address you sign in with.`,
    verify_email: 'Confirm your email address first: open the link we sent when you signed up, then try again.',
    offline: 'Connect to the internet once so the app can check your access. After that it works offline until your access ends.',
  };
  return (
    <Sheet title={`${FEATURE_NAMES[feature]} is a Pro tool`} onClose={onClose}>
      <p className="muted">{text[why]}</p>
      <p className="muted">Every other tool stays free, with no account needed.</p>
      <div className="row">
        <span />
        <span className="actions">
          <button className="ghost" onClick={onClose}>
            Not now
          </button>
          {why === 'signin' ? (
            <button className="primary" onClick={onSignIn}>
              Sign in
            </button>
          ) : mail && (why === 'trial_ended' || why === 'license_ended') ? (
            <a className="primary pill" href={mail}>
              Get a licence
            </a>
          ) : null}
        </span>
      </div>
    </Sheet>
  );
}
