import { useEffect, useRef, useState } from 'react';
import type { MetaPreview } from '../../../shared/types';
import { api } from '../api';
import { Empty, ErrorNote, Loading, PosterCard } from '../components/ui';
import { useRouter } from '../lib';

export function SearchPage() {
  const { search, navigate } = useRouter();
  const [query, setQuery] = useState(search.get('q') ?? '');
  const [results, setResults] = useState<{ movies: MetaPreview[]; series: MetaPreview[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  // The top bar can change ?q= while this page is open.
  const urlQuery = search.get('q') ?? '';
  useEffect(() => { setQuery(urlQuery); }, [urlQuery]);
  useEffect(() => { if (!urlQuery) inputRef.current?.focus(); }, [urlQuery]);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) { setResults(null); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(undefined);
      if (text !== urlQuery) navigate(`/search?q=${encodeURIComponent(text)}`, { replace: true });
      try {
        const value = await api.search(text);
        if (alive) setResults(value);
      } catch (failure) {
        if (alive) setError((failure as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const nothing = results && !results.movies.length && !results.series.length;

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'block' }}>
        <h1 className="page-title">Search</h1>
        <input
          ref={inputRef}
          className="input"
          style={{ marginTop: 18, height: 44, fontSize: 16, maxWidth: 640 }}
          placeholder="Title, or an IMDb ID like tt0903747"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {error && <ErrorNote message={error} />}
      {loading && !results && <Loading text="Searching" />}
      {!query.trim() && <Empty title="Find a title">Search movies and series, then choose a season pack, a whole season or single episodes.</Empty>}
      {nothing && <Empty title="No matches">Check the spelling, or paste the IMDb ID.</Empty>}
      {results && results.series.length > 0 && (
        <section style={{ marginBottom: 40 }}>
          <div className="label" style={{ marginBottom: 14 }}>Series · {results.series.length}</div>
          <div className="grid">{results.series.map((item) => <PosterCard key={item.id} item={item} />)}</div>
        </section>
      )}
      {results && results.movies.length > 0 && (
        <section>
          <div className="label" style={{ marginBottom: 14 }}>Films · {results.movies.length}</div>
          <div className="grid">{results.movies.map((item) => <PosterCard key={item.id} item={item} />)}</div>
        </section>
      )}
    </div>
  );
}
