'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Inbox, MoreHorizontal, type LucideIcon } from 'lucide-react';
import type { UploadProgress } from '@/lib/client/uploader';
import { fmtBytes } from '@/lib/client/format';

// Small, dependency-free UI primitives. Text is always rendered as React text (escaped); nothing uses
// dangerouslySetInnerHTML.

// ---- notices -----------------------------------------------------------------------------------------------
interface Notice {
  text: string;
  error: boolean;
}
const NoticeCtx = createContext<(text: string, error?: boolean) => void>(() => undefined);
export function NoticeProvider({ children }: { children: ReactNode }) {
  const [n, setN] = useState<Notice>();
  const show = useCallback((text: string, error = false) => setN(text ? { text, error } : undefined), []);
  useEffect(() => {
    if (!n || n.error) return;
    const t = setTimeout(() => setN(undefined), 6000);
    return () => clearTimeout(t);
  }, [n]);
  return (
    <NoticeCtx.Provider value={show}>
      {children}
      <div className={`toast${n ? ' show' : ''}${n?.error ? ' error' : ''}`} role={n?.error ? 'alert' : 'status'} aria-live="polite">
        {n?.text}
        {n && (
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => setN(undefined)}>
            ×
          </button>
        )}
      </div>
    </NoticeCtx.Provider>
  );
}
export const useNotice = () => useContext(NoticeCtx);

// ---- layout ------------------------------------------------------------------------------------------------
export function Panel({ title, children, actions, className }: { title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <div className="panel-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
export function Empty({ children, icon: Icon = Inbox, action }: { children: ReactNode; icon?: LucideIcon; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon size={28} aria-hidden="true" />
      <div>{children}</div>
      {action}
    </div>
  );
}
export const Muted = ({ children }: { children: ReactNode }) => <p className="muted">{children}</p>;

const BADGE: Record<string, string> = { active: 'ok', available: 'ok', published: 'ok', open: 'ok', approved: 'ok', new: 'info' };
export function Badge({ state }: { state: string }) {
  return <span className={`badge ${BADGE[state] ?? 'off'}`}>{state.replace(/_/g, ' ')}</span>;
}

export function Table({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Details({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="details">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---- actions -----------------------------------------------------------------------------------------------
/** A button whose async action disables it while running and reports failures as a notice. */
export function Button({
  children,
  onClick,
  kind,
  disabled,
  title,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => unknown;
  kind?: 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}) {
  const [busy, setBusy] = useState(false);
  const notice = useNotice();
  return (
    <button
      type={type}
      title={title}
      className={kind ?? ''}
      disabled={disabled || busy}
      onClick={
        onClick &&
        (async () => {
          setBusy(true);
          try {
            await onClick();
          } catch (e) {
            notice((e as Error).message, true);
          } finally {
            setBusy(false);
          }
        })
      }
    >
      {children}
    </button>
  );
}

export interface FieldSpec {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'password' | 'number' | 'url' | 'date' | 'textarea' | 'select' | 'checkbox';
  options?: Array<[string, string]>;
  optional?: boolean;
  value?: string;
  min?: number;
  max?: number;
  placeholder?: string;
  autoComplete?: string;
  hint?: string;
  show?: (v: Record<string, string>) => boolean;
}

/** A simple form; resolves trimmed values (checkboxes as 'yes'/'') to `onSubmit`. */
export function Form({
  fields,
  submit,
  onSubmit,
  kind = 'primary',
}: {
  fields: FieldSpec[];
  submit: string;
  onSubmit: (v: Record<string, string>) => unknown;
  kind?: 'primary' | 'danger';
}) {
  const init = () => Object.fromEntries(fields.map((f) => [f.name, f.value ?? (f.type === 'select' ? (f.options?.[0]?.[0] ?? '') : '')]));
  const [v, setV] = useState<Record<string, string>>(init);
  const [busy, setBusy] = useState(false);
  const notice = useNotice();
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const submitForm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSubmit(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim()])));
    } catch (err) {
      notice((err as Error).message, true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submitForm}>
      {fields
        .filter((f) => !f.show || f.show(v))
        .map((f) => {
          const id = `f-${f.name}`;
          const common = {
            id,
            name: f.name,
            required: !f.optional && f.type !== 'checkbox',
            value: v[f.name] ?? '',
            placeholder: f.placeholder,
            autoComplete: f.autoComplete,
          };
          const set = (x: string) => setV((s) => ({ ...s, [f.name]: x }));
          if (f.type === 'checkbox')
            return (
              <label key={f.name} className="check">
                <input type="checkbox" id={id} checked={v[f.name] === 'yes'} onChange={(e) => set(e.target.checked ? 'yes' : '')} /> {f.label}
              </label>
            );
          return (
            <label key={f.name} htmlFor={id}>
              <span>
                {f.label}
                {f.optional && <em> (optional)</em>}
              </span>
              {f.type === 'textarea' ? (
                <textarea {...common} rows={4} onChange={(e) => set(e.target.value)} />
              ) : f.type === 'select' ? (
                <select {...common} onChange={(e) => set(e.target.value)}>
                  {f.options?.map(([val, label]) => (
                    <option key={val} value={val}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : (
                <input {...common} type={f.type ?? 'text'} min={f.min} max={f.max} onChange={(e) => set(e.target.value)} />
              )}
              {f.hint && <small>{f.hint}</small>}
            </label>
          );
        })}
      <div className="actions">
        <button type="submit" className={kind} disabled={busy}>
          {busy ? 'Working…' : submit}
        </button>
      </div>
    </form>
  );
}

export function CopyField({ value, label }: { value: string; label: string }) {
  const notice = useNotice();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="copy-row">
      <input ref={ref} readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} />
      <button
        type="button"
        onClick={async () => {
          ref.current?.select();
          try {
            await navigator.clipboard.writeText(value);
            notice('Copied.');
          } catch {
            notice('Select the text and copy it manually.');
          }
        }}
      >
        Copy
      </button>
    </div>
  );
}

export function Progress({ p, label }: { p: UploadProgress | undefined; label?: string }) {
  if (!p && !label) return null;
  const pct = p ? (p.total ? Math.round((p.sent / p.total) * 100) : 100) : 0;
  return (
    <div className="progress-row">
      <progress max={100} value={pct} aria-label="Upload progress" />
      <span className="muted">{label ?? (p ? `${fmtBytes(p.sent)} of ${fmtBytes(p.total)}${p.resumed ? ' · resumed' : ''}` : '')}</span>
    </div>
  );
}

/** Native confirm/prompt keep focus handling accessible and need no extra code. */
export const confirmAction = (msg: string) => window.confirm(msg);
export const ask = (msg: string) => window.prompt(msg) ?? undefined;

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className="modal">
      <div className="panel-head">
        <h2>{title}</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

// ---- row menu ("⋯") -----------------------------------------------------------------------------------------
export interface MenuItem {
  label: string;
  onSelect: () => unknown;
  danger?: boolean;
  hidden?: boolean;
}
/** A compact actions menu for list rows, so a row shows one control instead of a line of buttons. */
export function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const notice = useNotice();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const shown = items.filter((i) => !i.hidden);
  if (!shown.length) return null;
  return (
    <div className="row-menu" ref={ref}>
      <button type="button" className="row-menu-button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {open && (
        <div className="row-menu-list" role="menu">
          {shown.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              className={i.danger ? 'danger-item' : ''}
              onClick={async () => {
                setOpen(false);
                try {
                  await i.onSelect();
                } catch (e) {
                  notice((e as Error).message, true);
                }
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
