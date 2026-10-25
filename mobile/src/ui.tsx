import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

// Small building blocks shared by every screen: app bar, icon buttons, tool tiles, bottom sheets, snackbars and the
// progress overlay. One visual language: white surfaces, navy text, coral for the one primary action on a screen.

export function AppBar({ left, title, subtitle, right }: { left?: ReactNode; title: ReactNode; subtitle?: string; right?: ReactNode }) {
  return (
    <header className="appbar">
      {left ?? <span className="appbar-pad" />}
      <div className="appbar-title">
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      <div className="appbar-actions">{right}</div>
    </header>
  );
}

export function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button className={`icon-btn${active ? ' on' : ''}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <Icon size={22} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

/** A labelled icon in a bottom toolbar (viewer quick tools, edit palette, organize actions). */
export function BarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  role,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  role?: 'radio';
}) {
  return (
    <button className={`bar-btn${active ? ' on' : ''}`} disabled={disabled} onClick={onClick} {...(role ? { role, 'aria-checked': !!active } : {})}>
      <Icon size={22} strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

export interface ToolDef {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Accent of the round icon. */
  color: string;
  run: () => void;
}

/** A round, colour-coded tool icon with its name underneath. */
export function ToolTile({ tool, disabled }: { tool: ToolDef; disabled?: boolean }) {
  const Icon = tool.icon;
  return (
    <button className="tool-tile" disabled={disabled} onClick={tool.run}>
      <span className="tool-icon" style={{ background: `${tool.color}18`, color: tool.color }}>
        <Icon size={24} strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="tool-label">{tool.label}</span>
    </button>
  );
}

export function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-handle" aria-hidden="true" />
        <h2 className="sheet-title">{title}</h2>
        {children}
      </div>
    </>
  );
}

/** A row in a list or menu: leading icon, title, optional detail, optional trailing control. */
export function Row({
  icon: Icon,
  iconColor,
  title,
  detail,
  onClick,
  trailing,
}: {
  icon: LucideIcon;
  iconColor?: string;
  title: string;
  detail?: string;
  onClick: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="row-item">
      <button className="row-main" onClick={onClick}>
        <span className="row-icon" style={iconColor ? { color: iconColor, background: `${iconColor}14` } : undefined}>
          <Icon size={22} strokeWidth={2} aria-hidden="true" />
        </span>
        <span className="row-text">
          <strong>{title}</strong>
          {detail ? <span>{detail}</span> : null}
        </span>
      </button>
      {trailing}
    </div>
  );
}

export function Progress({ label }: { label: string }) {
  return (
    <div className="progress" role="status" aria-live="polite">
      <div className="progress-card">
        <span className="spinner" aria-hidden="true" />
        <p className="busy">{label}</p>
      </div>
    </div>
  );
}
