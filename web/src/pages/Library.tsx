import { Copy, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LibrarySummary, MetaPreview } from '../../../shared/types';
import { api } from '../api';
import { Empty, ErrorNote, Loading, Poster, Sheet, TabBar } from '../components/ui';
import { ago, bytes, copyText, useAsync, usePolling, useRouter, useToast } from '../lib';

function AddonCard() {
  const toast = useToast();
  const { data, error } = useAsync(() => api.addon(), []);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <div className="skeleton" style={{ height: 150, marginBottom: 26 }} />;
  return (
    <section className="card addon-card">
      <div style={{ minWidth: 0 }}>
        <h2>Watch your library in Nuvio{data.enabled ? '' : ' (turned off in Settings)'}</h2>
        <p>Add this address once in Nuvio under Settings → Addons, or in Stremio. Your shows and movies appear as their own rows, and anything you own plays straight from this machine. Keep it private.</p>
        <div className="url" title={data.manifestUrl}>{data.manifestUrl}</div>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={async () => toast(await copyText(data.manifestUrl) ? 'Addon address copied' : 'Copy failed. Select the address and copy it.')}><Copy size={15} />Copy address</button>
        <a className="btn" href={data.stremioUrl}><ExternalLink size={15} />Open in Stremio</a>
      </div>
    </section>
  );
}

function MatchSheet({ item, onClose, onSaved }: { item: LibrarySummary; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [query, setQuery] = useState(item.title);
  const [results, setResults] = useState<MetaPreview[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (query.trim().length < 2) return;
    let alive = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const found = await api.search(query.trim());
        if (alive) setResults(item.type === 'series' ? found.series : found.movies);
      } catch {
        if (alive) setResults([]);
      } finally {
        if (alive) setLoading(false);
      }
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, item.type]);
  const choose = async (imdbId: string | null) => {
    try {
      await api.matchLibraryItem(item.id, imdbId);
      toast(imdbId ? `Matched ${item.title}` : 'Match removed');
      onSaved();
      onClose();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };
  return (
    <Sheet
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="Which title is this folder?"
      description={item.folder}
      footer={<><span className="hint">The match sets the artwork, and which title plays these files in Nuvio.</span>{item.matched && <button className="btn sm danger" onClick={() => choose(null)}>Remove match</button>}</>}
    >
      <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus style={{ marginBottom: 18 }} aria-label="Search for the title" />
      {loading && <Loading text="Searching…" />}
      <div className="grid">
        {results.map((result) => (
          <button key={result.id} className="poster-card" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left' }} onClick={() => choose(result.id)}>
            <Poster src={result.poster} title={result.name} />
            <div className="poster-name truncate">{result.name}</div>
            <div className="poster-sub">{result.releaseInfo}</div>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function LibraryPage() {
  const toast = useToast();
  const { navigate } = useRouter();
  const { data, error, reload, setData } = useAsync(() => api.library(), []);
  const [tab, setTab] = useState<'series' | 'movie'>('series');
  const [query, setQuery] = useState('');
  const [fixing, setFixing] = useState<LibrarySummary | null>(null);
  usePolling(() => { api.library().then(setData, () => undefined); }, 3000, Boolean(data?.scanning));

  const all = data?.items ?? [];
  const shows = all.filter((item) => item.type === 'series');
  const movies = all.filter((item) => item.type === 'movie');
  const items = (tab === 'series' ? shows : movies).filter((item) => !query || item.title.toLowerCase().includes(query.toLowerCase()));
  const unmatched = (tab === 'series' ? shows : movies).filter((item) => !item.matched).length;

  return (
    <div className="canvas">
      <div className="title-row">
        <div>
          <h1>Library</h1>
          {data && <div className="sub num">{shows.length} shows · {movies.length} movies · {bytes(all.reduce((sum, item) => sum + item.size, 0))} · checked {ago(data.scannedAt)}</div>}
        </div>
        <button className="btn" disabled={data?.scanning} onClick={async () => { await api.scanLibrary(); toast('Checking your folders for new files'); setTimeout(reload, 1200); }}>
          {data?.scanning ? <><span className="spinner" />Checking</> : 'Check folders'}
        </button>
      </div>
      <AddonCard />
      {error && <ErrorNote message={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && (
        <>
          <TabBar value={tab} onChange={setTab} tabs={[{ value: 'series', label: 'Shows', count: shows.length }, { value: 'movie', label: 'Movies', count: movies.length }]} />
          <div className="toolbar">
            <input className="input filter" placeholder={`Filter ${tab === 'series' ? 'shows' : 'movies'}`} value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Filter the library" />
            <span className="count">{unmatched > 0 ? `${unmatched} need a match · ` : ''}{items.length} {tab === 'series' ? 'shows' : 'movies'}</span>
          </div>
          {!items.length && (
            <Empty title={query ? 'Nothing matches' : `No ${tab === 'series' ? 'shows' : 'movies'} yet`}>
              {query ? 'Try another name.' : 'Downloads land here. Folders you already had appear after the next check.'}
            </Empty>
          )}
          <div className="grid" style={{ marginTop: 16 }}>
            {items.map((item) => (
              <div key={item.id} className="poster-card" onClick={() => (item.imdbId ? navigate(`/title/${item.type}/${item.imdbId}`) : setFixing(item))}>
                <Poster src={item.poster} title={item.title} />
                <div className="poster-name truncate" title={item.title}>{item.title}</div>
                <div className="poster-sub row" style={{ justifyContent: 'space-between' }}>
                  <span>{item.type === 'series' ? `${item.fileCount} episode${item.fileCount === 1 ? '' : 's'}` : item.year ?? bytes(item.size)}</span>
                  {item.matched
                    ? <button className="btn ghost sm" style={{ height: 20, padding: '0 6px', fontSize: 12 }} onClick={(event) => { event.stopPropagation(); setFixing(item); }}>Change</button>
                    : <button className="pill warning" style={{ border: 0, cursor: 'pointer' }} onClick={(event) => { event.stopPropagation(); setFixing(item); }}>Needs a match</button>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {fixing && <MatchSheet item={fixing} onClose={() => setFixing(null)} onSaved={reload} />}
    </div>
  );
}
