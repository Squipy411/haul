import { createContext, useContext, useEffect } from 'react';
import type { DiskSpace, Status } from '../../shared/types';

// A page can put its own name in the top bar (a title page shows "Back · Breaking Bad").
export const CrumbContext = createContext<(crumb: string | null) => void>(() => undefined);
export function useCrumb(crumb: string | null) {
  const set = useContext(CrumbContext);
  useEffect(() => { set(crumb); return () => set(null); }, [crumb, set]);
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
