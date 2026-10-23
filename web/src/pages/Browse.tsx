import { useEffect, useRef, useState } from 'react';
import type { MediaType, MetaPreview } from '../../../shared/types';
import { api } from '../api';
import { ErrorNote, Loading, PosterCard, TabBar } from '../components/ui';
import { useQueryState, useRouter } from '../lib';

const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller'];

/** What each list had loaded (Load more included), so going back to it shows the same titles at once
 *  and lands where you were. Kept ten minutes. */
const loaded = new Map<string, { at: number; items: MetaPreview[]; done: boolean }>();

export function Browse({ type, catalog }: { type: MediaType; catalog: string }) {
  const year = new Date().getFullYear();
  const [genre, setGenre] = useQueryState('genre', catalog === 'year' ? String(year) : '');
  const key = `${type}/${catalog}/${genre}`;
  const remembered = (() => { const hit = loaded.get(key); return hit && Date.now() - hit.at < 10 * 60_000 ? hit : undefined; })();
  const [items, setItems] = useState<MetaPreview[]>(() => remembered?.items ?? []);
  const [loading, setLoading] = useState(!remembered);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(remembered?.done ?? false);
  const latest = useRef(0);

  const { navigate } = useRouter();
  const title = type === 'series' ? 'Shows' : 'Movies';

  const load = async (skip: number) => {
    const token = ++latest.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await api.catalog(type, catalog, { genre: genre || undefined, skip });
      // A newer request (another genre) won.
      if (token !== latest.current) return;
      const finished = result.items.length < 20;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        const next = skip ? [...current, ...result.items.filter((item) => !seen.has(item.id))] : result.items;
        loaded.set(key, { at: Date.now(), items: next, done: finished });
        return next;
      });
      setDone(finished);
    } catch (failure) {
      if (token === latest.current) setError((failure as Error).message);
    } finally {
      if (token === latest.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (remembered) { latest.current += 1; setItems(remembered.items); setDone(remembered.done); setLoading(false); setError(undefined); return; }
    setItems([]);
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, catalog, genre]);

  // The next page loads as you near the bottom, instead of waiting for a button.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || done || loading || error || !items.length) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void load(items.length); }, { rootMargin: '800px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, loading, error, items.length]);

  const options = catalog === 'year' ? Array.from({ length: 8 }, (_, index) => String(year - index)) : ['', ...GENRES];

  return (
    <div className="canvas">
      <div className="title-row"><h1>{title}</h1></div>
      <TabBar value={catalog} onChange={(value) => navigate(`/browse/${type}/${value}`, { replace: true })} tabs={[{ value: 'top', label: 'Popular' }, { value: 'year', label: 'New' }, { value: 'imdbRating', label: 'Top rated' }]} />
      <div className="chips browse-chips">
        {options.map((option) => (
          <button key={option || 'all'} type="button" className="chip" aria-pressed={genre === option} onClick={() => setGenre(option)}>{option || (catalog === 'year' ? 'Any year' : 'All genres')}</button>
        ))}
      </div>
      {error && <ErrorNote message={error} onRetry={() => load(items.length)} />}
      <div className="grid">{items.map((item) => <PosterCard key={item.id} item={item} />)}</div>
      {loading && <Loading />}
      {!done && items.length > 0 && <div ref={sentinel} aria-hidden="true" style={{ height: 1 }} />}
      {done && items.length > 0 && <p className="faint" style={{ marginTop: 28, fontSize: 13 }}>That's everything in this list.</p>}
    </div>
  );
}
