import { useEffect, useState } from 'react';
import type { MediaType, MetaPreview } from '../../../shared/types';
import { api } from '../api';
import { ErrorNote, Loading, PosterCard } from '../components/ui';
import { useRouter } from '../lib';

const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller'];

export function Browse({ type, catalog }: { type: MediaType; catalog: string }) {
  const { back } = useRouter();
  const year = new Date().getFullYear();
  const [genre, setGenre] = useState<string>(catalog === 'year' ? String(year) : '');
  const [items, setItems] = useState<MetaPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  const load = async (skip: number) => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await api.catalog(type, catalog, { genre: genre || undefined, skip });
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return skip ? [...current, ...result.items.filter((item) => !seen.has(item.id))] : result.items;
      });
      setDone(result.items.length < 20);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setItems([]); void load(0); }, [type, catalog, genre]);

  const noun = type === 'series' ? 'series' : 'films';
  const title = catalog === 'top' ? `Popular ${noun}` : catalog === 'year' ? `New ${noun}` : `Top rated ${noun}`;
  const options = catalog === 'year' ? Array.from({ length: 8 }, (_, index) => String(year - index)) : ['', ...GENRES];

  return (
    <div className="page">
      <button className="btn quiet" style={{ marginLeft: -8, marginBottom: 10 }} onClick={() => back('/')}>← Back</button>
      <div className="page-head" style={{ display: 'block' }}>
        <h1 className="page-title">{title}</h1>
        <div className="filters" style={{ marginTop: 18 }}>
          {options.map((option) => (
            <button key={option || 'all'} className={genre === option ? 'on' : ''} onClick={() => setGenre(option)}>{option || 'All'}</button>
          ))}
        </div>
      </div>
      {error && <ErrorNote message={error} onRetry={() => load(items.length)} />}
      <div className="grid">{items.map((item) => <PosterCard key={item.id} item={item} />)}</div>
      {loading && <Loading />}
      {!loading && !done && items.length > 0 && (
        <div style={{ marginTop: 30 }}><button className="btn" onClick={() => load(items.length)}>Load more</button></div>
      )}
    </div>
  );
}
