import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MetaPreview } from '../../../shared/types';
import { api } from '../api';
import { ErrorNote, MetaLine, PosterCard, Shelf, ShelfPlaceholder } from '../components/ui';
import { Link, useAsync } from '../lib';

function Featured({ items }: { items: MetaPreview[] }) {
  const [index, setIndex] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const restart = () => {
    if (timer.current) clearInterval(timer.current);
    if (items.length > 1) timer.current = setInterval(() => setIndex((value) => (value + 1) % items.length), 10000);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { restart(); return () => { if (timer.current) clearInterval(timer.current); }; }, [items.length]);
  const go = (step: number) => { setIndex((value) => (value + step + items.length) % items.length); restart(); };

  const item = items[index];
  if (!item) return <div className="feature ph" />;
  return (
    <section className="feature">
      {items.map((entry, position) => (
        <div key={entry.id} className="feature-img" style={{ backgroundImage: `url(${entry.background})`, opacity: position === index ? 1 : 0 }} />
      ))}
      <div className="feature-body">
        <span className="label">{item.type === 'series' ? 'Popular series' : 'Popular film'}</span>
        <h1>{item.name}</h1>
        <MetaLine parts={[item.releaseInfo, ...(item.genres ?? []).slice(0, 3), item.imdbRating && `IMDb ${item.imdbRating}`]} />
        {item.description && <p>{item.description}</p>}
        <div className="row" style={{ marginTop: 6 }}>
          <Link to={`/title/${item.type}/${item.id}`} className="btn primary lg">{item.type === 'series' ? 'Pick seasons' : 'Pick a release'}</Link>
        </div>
      </div>
      {items.length > 1 && (
        <div className="feature-nav">
          <button className="btn sm icon" onClick={() => go(-1)} aria-label="Previous"><ChevronLeft size={15} /></button>
          <span>{String(index + 1).padStart(2, '0')} / {String(items.length).padStart(2, '0')}</span>
          <button className="btn sm icon" onClick={() => go(1)} aria-label="Next"><ChevronRight size={15} /></button>
        </div>
      )}
    </section>
  );
}

const CATALOG_ID: Record<string, string> = { top: 'top', new: 'year', featured: 'imdbRating' };

export function Discover() {
  const { data, error, reload } = useAsync(() => api.home(), []);

  const candidates = useMemo(() => {
    const rows = data?.rows ?? [];
    const pool = [...(rows.find((row) => row.id === 'series-top')?.items ?? []).slice(0, 6), ...(rows.find((row) => row.id === 'movie-top')?.items ?? []).slice(0, 5)];
    return pool.filter((item) => item.background && item.description);
  }, [data]);

  // Feature only titles whose backdrop loads; brand-new releases often have none yet.
  const [featured, setFeatured] = useState<MetaPreview[]>([]);
  useEffect(() => {
    let alive = true;
    let settled = 0;
    let committed = false;
    const loaded = new Set<string>();
    const finish = () => {
      settled += 1;
      const ready = candidates.filter((item) => loaded.has(item.id)).slice(0, 6);
      if (alive && !committed && (ready.length >= 4 || settled === candidates.length)) { committed = true; setFeatured(ready); }
    };
    for (const item of candidates) {
      const image = new Image();
      image.onload = () => { loaded.add(item.id); finish(); };
      image.onerror = finish;
      image.src = item.background!;
    }
    return () => { alive = false; };
  }, [candidates]);

  return (
    <div className="page">
      <Featured items={featured} />
      {error && <div style={{ marginTop: 24 }}><ErrorNote message={`Couldn't load the catalog: ${error}`} onRetry={reload} /></div>}
      {!data && !error && [0, 1].map((key) => (
        <section key={key}><div className="shelf-head"><span className="ph" style={{ width: 200, height: 26 }} /></div><ShelfPlaceholder /></section>
      ))}
      {data?.rows.map((row) => {
        const [type, kind] = row.id.split('-');
        return (
          <section key={row.id}>
            <div className="shelf-head">
              <h2 className="section-title">{row.title}</h2>
              <Link to={`/browse/${type}/${CATALOG_ID[kind!] ?? 'top'}`} className="label" style={{ color: 'var(--muted)' }}>View all →</Link>
            </div>
            <Shelf>{row.items.map((item) => <PosterCard key={item.id} item={item} />)}</Shelf>
          </section>
        );
      })}
    </div>
  );
}
