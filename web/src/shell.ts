import { createContext, useContext, useEffect } from 'react';

// A page can put its own name in the top bar (a title page shows "Back · Breaking Bad").
export const CrumbContext = createContext<(crumb: string | null) => void>(() => undefined);
export function useCrumb(crumb: string | null) {
  const set = useContext(CrumbContext);
  useEffect(() => { set(crumb); return () => set(null); }, [crumb, set]);
}

export const SearchContext = createContext<() => void>(() => undefined);
export const useOpenSearch = () => useContext(SearchContext);
