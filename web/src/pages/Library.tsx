import { AlertCircle, Copy, ExternalLink, FolderOpen, Library as LibraryIcon, Puzzle, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LibrarySummary, MetaPreview } from '../../../shared/types';
import { api } from '../api';
import { Empty, ErrorNote, Loading, Modal, Poster, Segmented } from '../components/ui';
import { ago, bytes, copyText, useAsync, usePolling, useRouter, useToast } from '../lib';

export function AddonCard() {
  const toast = useToast();
  const { data, error } = useAsync(() => api.addon(), []);
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  return (
    <div className="addon-card">
      <span className="icon-wrap"><Puzzle size={24} /></span>
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <b style={{ fontSize: 15 }}>Your Nuvio & Stremio addon</b>
          {data.enabled ? <span className="badge good">On</span> : <span className="badge bad">Off</span>}
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          Install this once in Nuvio (Settings → Addons → Install from URL). Your library shows up as catalogs, and anything you own plays as a "Haul" stream.
        </div>
        <div className="url-box">
          <code title={data.manifestUrl}>{data.manifestUrl}</code>
        </div>
      </div>
      <div className="row wrap">
        <button className="btn primary" onClick={async () => toast(await copyText(data.manifestUrl) ? 'Addon URL copied. Paste it into Nuvio.' : 'Copy failed', 'ok')}><Copy size={15} />Copy URL</button>
        <a className="btn" href={data.stremioUrl}><ExternalLink size={15} />Open in Stremio</a>
      </div>
    </div>
  );
}

function MatchModal({ item, onClose, onSaved }: { item: LibrarySummary; onClose: () => void; onSaved: () => void }) {
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
      } finally {
        if (alive) setLoading(false);
      }
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, item.type]);
  const choose = async (imdbId: string | null) => {
    try {
      await api.matchLibraryItem(item.id, imdbId);
      toast(imdbId ? 'Match saved' : 'Match cleared');
      onSaved();
      onClose();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };
  return (
    <Modal title="Fix match" subtitle={<span className="mono">{item.folder}</span>} onClose={onClose} footer={<><span className="faint" style={{ fontSize: 12.5 }}>Matches decide posters and which title plays this file in Nuvio.</span>{item.matched && <button className="btn ghost danger" onClick={() => choose(null)}>Remove match</button>}</>}>
      <div className="search-box" style={{ marginBottom: 16 }}>
        <Search size={18} />
        <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
      </div>
      {loading && <Loading />}
      <div className="grid-posters">
        {results.map((result) => (
          <button key={result.id} className="poster-card" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left' }} onClick={() => choose(result.id)}>
            <Poster src={result.poster} title={result.name} />
            <div className="poster-title ellipsis">{result.name}</div>
            <div className="poster-meta">{result.releaseInfo}</div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function LibraryPage() {
  const toast = useToast();
  const { navigate } = useRouter();
  const { data, error, reload, setData } = useAsync(() => api.library(), []);
  const [type, setType] = useState<'series' | 'movie'>('series');
  const [query, setQuery] = useState('');
  const [fixing, setFixing] = useState<LibrarySummary | null>(null);
  usePolling(() => { api.library().then(setData, () => undefined); }, 4000, Boolean(data?.scanning));

  const items = (data?.items ?? []).filter((item) => item.type === type && (!query || item.title.toLowerCase().includes(query.toLowerCase())));
  const movies = data?.items.filter((item) => item.type === 'movie') ?? [];
  const shows = data?.items.filter((item) => item.type === 'series') ?? [];
  const totalSize = (data?.items ?? []).reduce((sum, item) => sum + item.size, 0);
  const unmatched = (data?.items ?? []).filter((item) => !item.matched).length;

  const rescan = async () => {
    await api.scanLibrary();
    toast('Rescanning your folders…');
    setTimeout(reload, 1200);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Library</h1>
          <div className="page-sub">Everything in your Movies and TV Shows folders, hosted for Nuvio.</div>
        </div>
        <button className="btn" onClick={rescan} disabled={data?.scanning}>
          <RefreshCw size={15} className={data?.scanning ? 'spin' : ''} />{data?.scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </div>
      <AddonCard />
      {error && <ErrorNote message={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="row wrap" style={{ justifyContent: 'space-between', marginBottom: 20, gap: 14 }}>
            <div className="stats-row">
              <span><b>{shows.length}</b> shows</span>
              <span><b>{movies.length}</b> movies</span>
              <span><b>{bytes(totalSize)}</b> on disk</span>
              {unmatched > 0 && <span style={{ color: 'var(--warn)' }}><b style={{ color: 'inherit' }}>{unmatched}</b> need a match</span>}
              <span className="faint">Scanned {ago(data.scannedAt)}</span>
            </div>
            <div className="row">
              <div className="search-box" style={{ width: 220 }}>
                <Search size={16} />
                <input className="input" style={{ height: 36, fontSize: 13.5, paddingLeft: 38 }} placeholder="Filter" value={query} onChange={(event) => setQuery(event.target.value)} />
              </div>
              <Segmented value={type} onChange={setType} options={[{ value: 'series', label: `Shows ${shows.length}` }, { value: 'movie', label: `Movies ${movies.length}` }]} />
            </div>
          </div>
          {!items.length && (
            <Empty icon={<LibraryIcon size={34} />} title={query ? 'No matches' : `No ${type === 'series' ? 'shows' : 'movies'} yet`}>
              {query ? 'Try another name.' : 'Downloads land here automatically. Folders you already have are picked up on the next scan.'}
            </Empty>
          )}
          <div className="grid-posters">
            {items.map((item) => (
              <div key={item.id} className="poster-card" onClick={() => (item.imdbId ? navigate(`/title/${item.type}/${item.imdbId}`) : setFixing(item))}>
                <Poster src={item.poster} title={item.title} />
                <div className="poster-title ellipsis" title={item.title}>{item.title}</div>
                <div className="poster-meta row" style={{ gap: 6, justifyContent: 'space-between' }}>
                  <span>{item.type === 'series' ? `${item.fileCount} ep · ${item.seasons.length} season${item.seasons.length === 1 ? '' : 's'}` : item.year ?? bytes(item.size)}</span>
                  <button
                    className="btn ghost sm icon"
                    style={{ width: 24, height: 24 }}
                    title={item.matched ? 'Change match' : 'Not matched: click to fix'}
                    onClick={(event) => { event.stopPropagation(); setFixing(item); }}
                  >
                    {item.matched ? <FolderOpen size={13} /> : <AlertCircle size={14} color="var(--warn)" />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {fixing && <MatchModal item={fixing} onClose={() => setFixing(null)} onSaved={reload} />}
    </div>
  );
}
