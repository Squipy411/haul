import { createContext, useContext, useEffect } from 'react';
import type { DiskSpace, Status } from '../../shared/types';

// A page can put its own name in the top bar (a title page shows "Back · Breaking Bad").
export const CrumbContext = createContext<(crumb: string | null) => void>(() => undefined);
export function useCrumb(crumb: string | null) {
  const set = useContext(CrumbContext);
  useEffect(() => { set(crumb); return () => set(null); }, [crumb, set]);
}

// The tab's name: what's on screen (the latest name set wins), plus the download speed while
// something is downloading.
const pageTitles: Array<{ page: string | null }> = [];
let transferText = '';
function applyTitle(): void {
  const page = [...pageTitles].reverse().find((entry) => entry.page)?.page;
  document.title = page || transferText ? [transferText, page, 'Haul'].filter(Boolean).join(' · ') : 'Haul · TorBox player';
}
export function setTransferTitle(text: string): void {
  transferText = text;
  applyTitle();
}
export function usePageTitle(page: string | null): void {
  useEffect(() => {
    const entry = { page };
    pageTitles.push(entry);
    applyTitle();
    return () => { pageTitles.splice(pageTitles.indexOf(entry), 1); applyTitle(); };
  }, [page]);
}

export const SearchContext = createContext<() => void>(() => undefined);
export const useOpenSearch = () => useContext(SearchContext);

// The latest /api/status, polled by the shell, for pages that need it (free disk space).
export const StatusContext = createContext<Status | null>(null);
export const useStatus = () => useContext(StatusContext);

/** The disk a kind of file lands on: "Movies", "Shows" or "Downloads in progress". */
export function diskFor(status: Status | null, label: string): DiskSpace | undefined {
  return status?.disks?.find((disk) => disk.labels.includes(label));
}
