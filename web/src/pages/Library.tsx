import { useEffect, useState } from 'react';
import type { LibrarySummary, MetaPreview } from '../../../shared/types';
import { api } from '../api';
import { Empty, ErrorNote, Loading, Modal, Poster, Seg } from '../components/ui';
import { ago, bytes, copyText, useAsync, usePolling, useRouter, useToast } from '../lib';

function AddonPanel() {
  const toast = useToast();
  const { data, error } = useAsync(() => api.addon(), []);
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  return (
    <section className="addon">
      <div style={{ minWidth: 0 }}>
        <span className="label">Nuvio / Stremio addon {data.enabled ? '' : '· off'}</span>
        <h2>Watch this library in Nuvio</h2>
        <p>Install the URL once in Nuvio (Settings → Addons → install from URL). You get your shows and films as catalogs, and a “Haul” stream on anything you own. Keep the URL private.</p>
        <code className="url" title={data.manifestUrl}>{data.manifestUrl}</code>
      </div>
      <div className="row wrap">
        <button className="btn primary" onClick={async () => toast(await copyText(data.manifestUrl) ? 'Addon URL copied' : 'Copy failed', 'ok')}>Copy URL</button>
        <a className="btn" href={data.stremioUrl}>Open in Stremio</a>
      </div>
    </section>
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
      toast(imdbId ? 'Match saved' : 'Match removed');
      onSaved();
      onClose();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };
  return (
    <Modal
      title="Match this folder"
      subtitle={<span className="mono" style={{ fontSize: 12 }}>{item.folder}</span>}
      onClose={onClose}
      footer={<><span className="hint">The match sets the poster and which title plays these files in Nuvio.</span>{item.matched && <button className="btn sm danger" onClick={() => choose(null)}>Remove match</button>}</>}
    >
      <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus style={{ marginBottom: 18 }} />
      {loading && <Loading text="Searching" />}
      <div className="grid">
        {results.map((result) => (
          <button key={result.id} className="poster-card" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left' }} onClick={() => choose(result.id)}>
            <Poster src={result.poster} title={result.name} />
            <div className="poster-name ellipsis">{result.name}</div>
            <div className="poster-sub">{result.releaseInfo}</div>
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
  usePolling(() => { api.library().then(setData, () => undefined); }, 3000, Boolean(data?.scanning));

  const all = data?.items ?? [];
  const items = all.filter((item) => item.type === type && (!query || item.title.toLowerCase().includes(query.toLowerCase())));
  const shows = all.filter((item) => item.type === 'series');
  const films = all.filter((item) => item.type === 'movie');
  const unmatched = all.filter((item) => !item.matched).length;

  const rescan = async () => {
    await api.scanLibrary();
    toast('Rescanning folders');
    setTimeout(reload, 1200);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Library</h1>
          <div className="sub">Everything in your Movies and TV Shows folders, including what you had before Haul.</div>
        </div>
        <button className="btn" onClick={rescan} disabled={data?.scanning}>{data?.scanning ? 'Scanning…' : 'Rescan folders'}</button>
      </div>
      <AddonPanel />
      {error && <ErrorNote message={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="row wrap" style={{ justifyContent: 'space-between', gap: 16, marginBottom: 24 }}>
            <div className="figures-row">
              <span><b>{shows.length}</b>series</span>
              <span><b>{films.length}</b>films</span>
              <span><b>{bytes(all.reduce((sum, item) => sum + item.size, 0))}</b>on disk</span>
              {unmatched > 0 && <span className="warn"><b className="warn">{unmatched}</b>unmatched</span>}
              <span style={{ alignSelf: 'center' }}>scanned {ago(data.scannedAt)}</span>
            </div>
            <div className="row">
              <input className="input" style={{ width: 200, height: 30 }} placeholder="Filter" value={query} onChange={(event) => setQuery(event.target.value)} />
              <Seg value={type} onChange={setType} options={[{ value: 'series', label: 'SERIES' }, { value: 'movie', label: 'FILMS' }]} />
            </div>
          </div>
          {!items.length && (
            <Empty title={query ? 'No matches' : `No ${type === 'series' ? 'series' : 'films'} yet`}>
              {query ? 'Try another name.' : 'Downloads land here. Existing folders show up after the next scan.'}
            </Empty>
          )}
          <div className="grid">
            {items.map((item) => (
              <div key={item.id} className="poster-card" onClick={() => (item.imdbId ? navigate(`/title/${item.type}/${item.imdbId}`) : setFixing(item))}>
                <Poster src={item.poster} title={item.title} />
                <div className="poster-name ellipsis" title={item.title}>{item.title}</div>
                <div className="poster-sub" style={{ justifyContent: 'space-between' }}>
                  <span>{item.type === 'series' ? `${item.fileCount} ep` : item.year ?? bytes(item.size)}</span>
                  <button
                    className="btn quiet sm"
                    style={{ height: 'auto', padding: 0, fontSize: 11, color: item.matched ? undefined : 'var(--warn)' }}
                    onClick={(event) => { event.stopPropagation(); setFixing(item); }}
                  >
                    {item.matched ? 'match' : 'unmatched'}
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
