import { Check, ChevronLeft, ChevronRight, Star, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { MetaPreview } from '../../../shared/types';
import { Link } from '../lib';

export function Poster({ src, title, owned, rating }: { src?: string; title: string; owned?: boolean; rating?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="poster">
      {src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : <div className="fallback">{title}</div>}
      {owned && <span className="owned" title="In your library"><Check size={14} strokeWidth={3} /></span>}
      {rating && <span className="rating"><Star size={11} fill="currentColor" />{rating}</span>}
    </div>
  );
}

export function PosterCard({ item }: { item: MetaPreview }) {
  return (
    <Link to={`/title/${item.type}/${item.id}`} className="poster-card">
      <Poster src={item.poster} title={item.name} owned={item.inLibrary} rating={item.imdbRating} />
      <div className="poster-title ellipsis">{item.name}</div>
      {item.releaseInfo && <div className="poster-meta">{item.releaseInfo}</div>}
    </Link>
  );
}

export function Scroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (direction: number) => ref.current?.scrollBy({ left: direction * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <div className="scroller-wrap">
      <button className="scroll-btn left" onClick={() => scroll(-1)} aria-label="Scroll left"><ChevronLeft size={18} /></button>
      <div className="scroller" ref={ref}>{children}</div>
      <button className="scroll-btn right" onClick={() => scroll(1)} aria-label="Scroll right"><ChevronRight size={18} /></button>
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="scroller">
      {Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton" style={{ aspectRatio: '2 / 3' }} />)}
    </div>
  );
}

export function Modal({ title, subtitle, onClose, children, footer, wide }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" style={wide ? { width: 'min(940px, 100%)' } : undefined}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>{subtitle}</div>}
          </div>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label?: string }) {
  return (
    <label className="switch" aria-label={label}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span />
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (value: T) => void }) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button key={option.value} className={option.value === value ? 'on' : ''} onClick={() => onChange(option.value)} type="button">{option.label}</button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <div style={{ maxWidth: 440 }}>{children}</div>}
    </div>
  );
}

export function Loading() {
  return <div className="center-load"><div className="spinner lg" /></div>;
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice bad" style={{ alignItems: 'center' }}>
      <div className="grow">{message}</div>
      {onRetry && <button className="btn sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}
