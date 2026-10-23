import { X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { MetaPreview } from '../../../shared/types';
import { Link } from '../lib';

export function Poster({ src, title, owned }: { src?: string; title: string; owned?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="poster">
      {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : <div className="fallback">{title}</div>}
      {owned && <span className="owned">OWNED</span>}
    </div>
  );
}

export function PosterCard({ item }: { item: MetaPreview }) {
  return (
    <Link to={`/title/${item.type}/${item.id}`} className="poster-card">
      <Poster src={item.poster} title={item.name} owned={item.inLibrary} />
      <div className="poster-name ellipsis" title={item.name}>{item.name}</div>
      <div className="poster-sub">
        {item.releaseInfo && <span>{item.releaseInfo}</span>}
        {item.imdbRating && <span>★ {item.imdbRating}</span>}
      </div>
    </Link>
  );
}

export function Shelf({ children }: { children: ReactNode }) {
  return <div className="shelf">{children}</div>;
}

export function ShelfPlaceholder() {
  return (
    <div className="shelf">
      {Array.from({ length: 8 }, (_, index) => <div key={index} className="ph" style={{ aspectRatio: '2 / 3', borderRadius: 3 }} />)}
    </div>
  );
}

export function Modal({ title, subtitle, onClose, children, footer }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>{subtitle}</div>}
          </div>
          <button className="btn quiet icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label?: string }) {
  return (
    <label className="toggle" aria-label={label}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span />
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (value: T) => void }) {
  return (
    <div className="seg">
      {options.map((option) => (
        <button key={option.value} type="button" className={option.value === value ? 'on' : ''} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Loading({ text }: { text?: string }) {
  return text ? <div className="loading"><span className="spinner" />{text}</div> : <div className="center"><span className="spinner lg" /></div>;
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="note bad row" style={{ justifyContent: 'space-between' }}>
      <span>{message}</span>
      {onRetry && <button className="btn sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

/** "2026 / Drama / Horror" with quiet separators. */
export function MetaLine({ parts }: { parts: Array<ReactNode | undefined | false> }) {
  const shown = parts.filter((part) => part !== undefined && part !== false && part !== '');
  return (
    <div className="meta-line">
      {shown.map((part, index) => <span key={index}>{index > 0 && <span className="sep">/</span>}{part}</span>)}
    </div>
  );
}
