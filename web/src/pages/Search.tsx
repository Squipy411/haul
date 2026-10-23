import { Film, Search as SearchIcon, Tv } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MetaPreview } from '../../../shared/types';
import { api } from '../api';
import { Empty, ErrorNote, Loading, PosterCard } from '../components/ui';
import { useRouter } from '../lib';

export function SearchPage() {
  const { search, navigate } = useRouter();
  const initial = search.get('q') ?? '';
  const [query, setQuery] = useState(initial);
  const [results, setResults] = useState<{ movies: MetaPreview[]; series: MetaPreview[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) { setResults(null); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(undefined);
      navigate(`/search?q=${encodeURIComponent(text)}`, { replace: true });
      try {
        const value = await api.search(text);
        if (alive) setResults(value);
      } catch (failure) {
        if (alive) setError((failure as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    }, 320);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, navigate]);

  const nothing = results && !results.movies.length && !results.series.length;

  return (
    <div className="page">
      <div className="page-head"><div><h1 className="page-title">Search</h1><div className="page-sub">Find any movie or show, then pick exactly what to download.</div></div></div>
      <div className="search-box" style={{ maxWidth: 680, marginBottom: 30 }}>
        <SearchIcon size={18} />
        <input ref={inputRef} className="input" placeholder="Title or IMDb ID (tt…)" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {error && <ErrorNote message={error} />}
      {loading && !results && <Loading />}
      {!query.trim() && <Empty icon={<SearchIcon size={34} />} title="What are you looking for?">Search the full catalog of movies and TV, then choose a season pack, a whole season or single episodes.</Empty>}
      {nothing && <Empty icon={<SearchIcon size={34} />} title="No matches">Try a different spelling, or paste the IMDb ID.</Empty>}
      {results && results.series.length > 0 && (
        <section className="result-group">
          <h2 className="section-title" style={{ marginBottom: 14 }}><Tv size={18} />Shows</h2>
          <div className="grid-posters">{results.series.map((item) => <PosterCard key={item.id} item={item} />)}</div>
        </section>
      )}
      {results && results.movies.length > 0 && (
        <section className="result-group">
          <h2 className="section-title" style={{ marginBottom: 14 }}><Film size={18} />Movies</h2>
          <div className="grid-posters">{results.movies.map((item) => <PosterCard key={item.id} item={item} />)}</div>
        </section>
      )}
    </div>
  );
}
