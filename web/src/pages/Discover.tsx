import { ArrowRight, Download, Search, Star } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { MetaPreview } from '../../../shared/types';
import { api } from '../api';
import { ErrorNote, PosterCard, Scroller, SkeletonRow } from '../components/ui';
import { Link, useAsync, useRouter } from '../lib';

function Hero({ items }: { items: MetaPreview[] }) {
  const [index, setIndex] = useState(0);
  const [logoFailed, setLogoFailed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (items.length < 2) return;
    const timer = setInterval(() => setIndex((value) => (value + 1) % items.length), 9000);
    return () => clearInterval(timer);
  }, [items.length]);
  const item = items[index];
  if (!item) return <div className="hero skeleton" style={{ borderRadius: 0 }} />;
  return (
    <section className="hero">
      {items.map((entry, entryIndex) => (
        <div key={entry.id} className="hero-bg" style={{ backgroundImage: `url(${entry.background})`, opacity: entryIndex === index ? 1 : 0 }} />
      ))}
      <div className="hero-content">
        <span className="badge" style={{ width: 'fit-content', background: 'rgba(255,255,255,0.1)', color: '#fff' }}>
          {item.type === 'series' ? 'Trending show' : 'Trending movie'}
        </span>
        {item.logo && !logoFailed[item.id]
          ? <img className="hero-logo" src={item.logo} alt={item.name} onError={() => setLogoFailed((value) => ({ ...value, [item.id]: true }))} />
          : <h1>{item.name}</h1>}
        <div className="hero-meta">
          {item.imdbRating && <span className="star"><Star size={14} fill="currentColor" />{item.imdbRating}</span>}
          {item.releaseInfo && <span>{item.releaseInfo}</span>}
          {item.genres?.slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}
        </div>
        {item.description && <p>{item.description}</p>}
        <div className="row wrap" style={{ marginTop: 4 }}>
          <Link to={`/title/${item.type}/${item.id}`} className="btn primary lg"><Download size={17} />{item.type === 'series' ? 'Choose seasons' : 'Choose quality'}</Link>
          <div className="hero-dots" style={{ marginLeft: 8 }}>
            {items.map((entry, entryIndex) => (
              <button key={entry.id} className={entryIndex === index ? 'on' : ''} onClick={() => setIndex(entryIndex)} aria-label={`Show ${entry.name}`} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function Discover() {
  const { navigate } = useRouter();
  const { data, error, reload } = useAsync(() => api.home(), []);
  const [query, setQuery] = useState('');

  const candidates = useMemo(() => {
    const rows = data?.rows ?? [];
    const pool = [...(rows.find((row) => row.id === 'series-top')?.items ?? []).slice(0, 6), ...(rows.find((row) => row.id === 'movie-top')?.items ?? []).slice(0, 5)];
    return pool.filter((item) => item.background && item.description);
  }, [data]);
  // Only feature titles whose backdrop actually loads; brand-new titles often have none yet.
  const [heroItems, setHeroItems] = useState<MetaPreview[]>([]);
  useEffect(() => {
    let alive = true;
    const loaded = new Set<string>();
    let settled = 0;
    let committed = false;
    for (const item of candidates) {
      const image = new Image();
      image.onload = () => { loaded.add(item.id); finish(); };
      image.onerror = finish;
      image.src = item.background!;
    }
    function finish() {
      settled += 1;
      if (!alive) return;
      const ready = candidates.filter((item) => loaded.has(item.id)).slice(0, 6);
      if (!committed && (ready.length >= 4 || settled === candidates.length)) { committed = true; setHeroItems(ready); }
    }
    return () => { alive = false; };
  }, [candidates]);

  return (
    <div className="page flush">
      <Hero items={heroItems} />
      <div className="discover-body">
        <form
          className="search-box"
          style={{ maxWidth: 560, marginTop: 8 }}
          onSubmit={(event) => { event.preventDefault(); if (query.trim()) navigate(`/search?q=${encodeURIComponent(query.trim())}`); }}
        >
          <Search size={18} />
          <input className="input" placeholder="Search movies and shows…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </form>
        {error && <div style={{ marginTop: 20 }}><ErrorNote message={`Couldn't load the catalog: ${error}`} onRetry={reload} /></div>}
        {!data && !error && Array.from({ length: 3 }, (_, index) => (
          <div key={index}><div className="row-head"><div className="skeleton" style={{ width: 180, height: 20 }} /></div><SkeletonRow /></div>
        ))}
        {data?.rows.map((row) => {
          const [type, catalog] = row.id.split('-');
          const catalogId = catalog === 'top' ? 'top' : catalog === 'new' ? 'year' : 'imdbRating';
          return (
            <section key={row.id}>
              <div className="row-head">
                <h2 className="section-title">{row.title}</h2>
                <Link to={`/browse/${type}/${catalogId}`}>See all <ArrowRight size={13} style={{ verticalAlign: -2 }} /></Link>
              </div>
              <Scroller>
                {row.items.map((item) => <PosterCard key={item.id} item={item} />)}
              </Scroller>
            </section>
          );
        })}
      </div>
    </div>
  );
}
