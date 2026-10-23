import NumberFlow from '@number-flow/react';
import { Check, ChevronDown, X } from 'lucide-react';
import { Checkbox, Dialog, DropdownMenu, Select, Switch, Tabs, Tooltip } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import type { MetaPreview } from '../../../shared/types';
import { rememberPreview } from '../api';
import { hoverPreviews } from './HoverPreview';
import { Link } from '../lib';

/** The product's mark: a box opening onto a play button. */
/** An open box with a play button rising out of it: what you fetch, ready to watch. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="66 60 380 380" aria-hidden="true" className="mark">
      <path className="mark-play" d="M206 96 L206 268 L342 182 Z" fill="#4cb3f0" stroke="#4cb3f0" strokeWidth="30" strokeLinejoin="round" />
      <g fill="#ffffff" stroke="#ffffff" strokeWidth="18" strokeLinejoin="round">
        <path className="mark-flap left" d="M122 246 L80 190 L170 190 L206 246 Z" />
        <path className="mark-flap right" d="M390 246 L432 190 L342 190 L306 246 Z" />
      </g>
      <path d="M120 262 L392 262 L392 384 Q392 420 356 420 L156 420 Q120 420 120 384 Z" fill="#ffffff" />
    </svg>
  );
}

export function Poster({ src, title, owned }: { src?: string; title: string; owned?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="poster">
      {src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <div className="fallback">{title}</div>}
      {owned && <span className="owned pill positive">In library</span>}
    </div>
  );
}

export function PosterCard({ item }: { item: MetaPreview }) {
  return (
    <Link
      to={`/title/${item.type}/${item.id}`}
      className="poster-card"
      onClick={() => rememberPreview(item)}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') hoverPreviews.enter(item, event.currentTarget); }}
      onPointerLeave={hoverPreviews.leave}
    >
      <Poster src={item.poster} title={item.name} owned={item.inLibrary} />
      <div className="poster-name truncate" title={item.name}>{item.name}</div>
      <div className="poster-sub">{[item.releaseInfo, item.imdbRating && `IMDb ${item.imdbRating}`].filter(Boolean).join(' · ')}</div>
    </Link>
  );
}

export function Sheet({ open, onOpenChange, title, description, children, footer }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <div>
              <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
              {description ? <Dialog.Description asChild><p>{description}</p></Dialog.Description> : <Dialog.Description className="sr-only" />}
            </div>
            <Dialog.Close asChild><button className="btn ghost icon" aria-label="Close"><X size={18} /></button></Dialog.Close>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Toggle({ checked, onChange, label, id }: { checked: boolean; onChange: (value: boolean) => void; label?: string; id?: string }) {
  return (
    <Switch.Root id={id} className="switch" checked={checked} onCheckedChange={onChange} aria-label={label}>
      <Switch.Thumb className="switch-thumb" />
    </Switch.Root>
  );
}

export function Tick({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <Checkbox.Root className="check" checked={checked} onCheckedChange={(value) => onChange(value === true)} aria-label={label} disabled={disabled}>
      <Checkbox.Indicator><Check size={13} strokeWidth={3} /></Checkbox.Indicator>
    </Checkbox.Root>
  );
}

export function TabBar<T extends string>({ value, onChange, tabs }: { value: T; onChange: (value: T) => void; tabs: Array<{ value: T; label: string; count?: number }> }) {
  return (
    <Tabs.Root value={value} onValueChange={(next) => onChange(next as T)}>
      <Tabs.List className="tabs-list">
        {tabs.map((tab) => (
          <Tabs.Trigger key={tab.value} value={tab.value} className="tab">
            {tab.label}{tab.count !== undefined && <span className="n">{tab.count}</span>}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}

export function Picker<T extends string | number>({ value, onChange, options, label }: { value: T; onChange: (value: T) => void; options: Array<{ value: T; label: string; hint?: string }>; label: string }) {
  const current = options.find((option) => option.value === value);
  return (
    <Select.Root value={String(value)} onValueChange={(next) => onChange(options.find((option) => String(option.value) === next)!.value)}>
      <Select.Trigger className="select-trigger" aria-label={label}>
        <Select.Value>{current?.label}</Select.Value>
        <Select.Icon><ChevronDown size={15} /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="popover" position="popper" sideOffset={6}>
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item key={String(option.value)} value={String(option.value)} className="popover-item">
                <Select.ItemText>{option.label}</Select.ItemText>
                {option.hint && <span className="faint" style={{ fontSize: 12 }}>{option.hint}</span>}
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export interface MenuAction { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }

export function Menu({ trigger, actions, label }: { trigger: ReactNode; actions: Array<MenuAction | 'separator'>; label: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild aria-label={label}>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="popover" align="end" sideOffset={6}>
          {actions.map((action, index) => action === 'separator'
            ? <DropdownMenu.Separator key={index} className="popover-sep" />
            : (
              <DropdownMenu.Item key={action.label} className={`popover-item ${action.danger ? 'danger' : ''}`} disabled={action.disabled} onSelect={action.onSelect}>
                {action.label}
              </DropdownMenu.Item>
            ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip.Root delayDuration={300}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={6}>{text}</Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** A figure that updates in place without the digits jumping. */
export function Figure({ value, suffix, decimals = 0 }: { value: number; suffix?: string; decimals?: number }) {
  return <NumberFlow value={value} suffix={suffix} format={{ maximumFractionDigits: decimals, minimumFractionDigits: decimals }} willChange />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><b>{title}</b>{children}</div>;
}

export function Loading({ text }: { text?: string }) {
  return text ? <div className="loading"><span className="spinner" />{text}</div> : <div className="center"><span className="spinner lg" /></div>;
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice negative row" style={{ justifyContent: 'space-between' }}>
      <span>{message}</span>
      {onRetry && <button className="btn sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export const join = (parts: Array<string | number | undefined | false | null>) => parts.filter((part) => part !== undefined && part !== false && part !== null && part !== '').join(' · ');
