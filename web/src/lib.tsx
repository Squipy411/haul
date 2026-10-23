import {
  type AnchorHTMLAttributes, type MouseEvent, type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState
} from 'react';
import { Toaster, toast } from 'sonner';

// ---------- Router ----------
interface RouterValue {
  path: string;
  search: URLSearchParams;
  navigate: (to: string, options?: { replace?: boolean }) => void;
  /** Goes back inside the app, or to `fallback` when the page was opened directly. */
  back: (fallback?: string) => void;
}

const RouterContext = createContext<RouterValue>({ path: '/', search: new URLSearchParams(), navigate: () => undefined, back: () => undefined });

/** Where each history entry was scrolled to, so Back (and Forward) land where you were. */
const scrolls = new Map<number, number>();
let entryKey = 0;
let shownKey = 0;
let restoring = 0;
const currentEntry = (): { key: number; depth: number } => window.history.state ?? { key: 0, depth: 0 };

/** Pages fill in as their data arrives, so keep trying for a few seconds until the page is tall
 *  enough, and give up the moment the person scrolls for themselves. */
function restoreScroll(y: number): void {
  window.cancelAnimationFrame(restoring);
  let tries = 0;
  const stop = () => {
    window.cancelAnimationFrame(restoring);
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) window.removeEventListener(type, stop);
  };
  for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) window.addEventListener(type, stop, { passive: true });
  const step = () => {
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) < 2 || ++tries > 180) return stop();
    restoring = window.requestAnimationFrame(step);
  };
  restoring = window.requestAnimationFrame(step);
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(() => ({ path: window.location.pathname, search: window.location.search }));
  const depth = useRef(0);
  useEffect(() => {
    window.history.scrollRestoration = 'manual';
    if (!window.history.state) window.history.replaceState({ key: ++entryKey, depth: 0 }, '');
    else entryKey = Math.max(entryKey, currentEntry().key);
    depth.current = currentEntry().depth;
    shownKey = currentEntry().key;
    const onScroll = () => { scrolls.set(shownKey, window.scrollY); };
    const onPop = () => {
      const entry = currentEntry();
      depth.current = entry.depth;
      shownKey = entry.key;
      setLocation({ path: window.location.pathname, search: window.location.search });
      restoreScroll(scrolls.get(entry.key) ?? 0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('popstate', onPop);
    };
  }, []);
  const navigate = useCallback((to: string, options: { replace?: boolean } = {}) => {
    if (to === window.location.pathname + window.location.search) return;
    const entry = currentEntry();
    scrolls.set(entry.key, window.scrollY);
    if (options.replace) window.history.replaceState({ key: entry.key, depth: entry.depth }, '', to);
    else {
      depth.current = entry.depth + 1;
      shownKey = ++entryKey;
      window.history.pushState({ key: shownKey, depth: depth.current }, '', to);
    }
    const url = new URL(to, window.location.origin);
    setLocation({ path: url.pathname, search: url.search });
    if (!options.replace) window.scrollTo({ top: 0 });
  }, []);
  const back = useCallback((fallback = '/') => {
    if (depth.current > 0) window.history.back();
    else navigate(fallback);
  }, [navigate]);
  const value = useMemo(() => ({ path: location.path, search: new URLSearchParams(location.search), navigate, back }), [location, navigate, back]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export const useRouter = () => useContext(RouterContext);

/** A page setting kept in the address (?tab=movie), so Back and a reload bring it back as it was. */
export function useQueryState<T extends string>(name: string, fallback: T): [T, (value: T) => void] {
  const { path, search, navigate } = useRouter();
  const value = (search.get(name) as T | null) ?? fallback;
  const set = useCallback((next: T) => {
    const query = new URLSearchParams(window.location.search);
    if (next === fallback) query.delete(name); else query.set(name, next);
    const text = query.toString();
    navigate(`${path}${text ? `?${text}` : ''}`, { replace: true });
  }, [name, fallback, path, navigate]);
  return [value, set];
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}

// ---------- Toasts (Sonner) ----------
type Notify = (message: ReactNode, kind?: 'ok' | 'error') => void;
const notify: Notify = (message, kind = 'ok') => { if (kind === 'error') toast.error(message); else toast(message); };
const ToastContext = createContext<Notify>(notify);

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <Toaster
        theme="dark"
        position="bottom-right"
        gap={8}
        toastOptions={{ style: { background: '#1c1c1c', border: '0', borderRadius: '14px', color: '#fff', fontSize: '14px' } }}
      />
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// ---------- Data hooks ----------
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | undefined; loading: boolean; reload: () => void; setData: (value: T) => void } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((current) => ({ data: current.data, loading: true }));
    load().then(
      (data) => alive && setState({ data, loading: false }),
      (error: Error) => alive && setState({ error: error.message, loading: false })
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    reload: () => setVersion((value) => value + 1),
    setData: (data: T) => setState({ data, loading: false })
  };
}

export function usePolling(callback: () => void, intervalMs: number, active = true): void {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!active) return;
    const tick = () => { if (document.visibilityState === 'visible') saved.current(); };
    const timer = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [intervalMs, active]);
}

// ---------- Formatting ----------
export function bytes(value?: number): string {
  if (!value || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export function speed(value?: number): string {
  return value && value > 0 ? `${bytes(value)}/s` : '';
}

export function duration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function ago(timestamp?: number): string {
  if (!timestamp) return 'never';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function airDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function pad(value: number): string {
  // Episode codes such as S01E04, not list numbering. taste-skill-ignore
  return String(value).padStart(2, '0');
}

export function episodeRange(episodes: number[]): string {
  if (!episodes.length) return '';
  const sorted = [...episodes].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0]!;
  let previous = start;
  for (const value of [...sorted.slice(1), Number.NaN]) {
    if (value === previous + 1) { previous = value; continue; }
    parts.push(start === previous ? `E${start}` : `E${start}–${previous}`);
    start = value;
    previous = value;
  }
  return parts.join(', ');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}
