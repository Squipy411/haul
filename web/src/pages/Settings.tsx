import { CheckCircle2, Copy, ExternalLink, FolderCheck, KeyRound, Lock, Plus, Puzzle, RefreshCw, Save, SlidersHorizontal, Trash2, Waypoints, XCircle } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { AddonInfo, Settings, SettingsPatch, TorboxAccount } from '../../../shared/types';
import { api } from '../api';
import { ErrorNote, Loading, Segmented, Switch } from '../components/ui';
import { copyText, useAsync, useToast } from '../lib';

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="label"><b>{title}</b>{description && <span>{description}</span>}</div>
      <div style={{ flex: 'none' }}>{children}</div>
    </div>
  );
}

function Section({ id, icon, title, description, children }: { id: string; icon: ReactNode; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} className="settings-section panel">
      <h2>{icon}{title}</h2>
      {description && <p className="desc">{description}</p>}
      {children}
    </section>
  );
}

function ListEditor({ values, onChange, placeholder }: { values: string[]; onChange: (values: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const add = () => { if (draft.trim()) { onChange([...values, draft.trim()]); setDraft(''); } };
  return (
    <div className="list-edit">
      {values.map((value, index) => (
        <div key={`${value}-${index}`} className="item">
          <input className="input mono" value={value} onChange={(event) => onChange(values.map((item, position) => (position === index ? event.target.value : item)))} />
          <button className="btn icon ghost danger" onClick={() => onChange(values.filter((_, position) => position !== index))} aria-label="Remove"><Trash2 size={15} /></button>
        </div>
      ))}
      <div className="item">
        <input className="input mono" placeholder={placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button className="btn icon" onClick={add} aria-label="Add"><Plus size={15} /></button>
      </div>
    </div>
  );
}

function AddonSection({ draft, update }: { draft: Settings; update: (patch: (value: Settings) => Settings) => void }) {
  const toast = useToast();
  const [info, setInfo] = useState<AddonInfo | null>(null);
  useEffect(() => { api.addon().then(setInfo, () => undefined); }, []);
  return (
    <Section id="addon" icon={<Puzzle size={18} />} title="Nuvio addon" description="Haul hosts your library as a Stremio-compatible addon, the same idea as your Personal Media Addon. Install the URL in Nuvio once.">
      <Row title="Addon enabled" description="Turn off to stop serving catalogs and streams.">
        <Switch checked={draft.addon.enabled} onChange={(enabled) => update((value) => ({ ...value, addon: { ...value.addon, enabled } }))} />
      </Row>
      <div className="form-grid" style={{ marginTop: 6 }}>
        <label className="field"><span>Name in Nuvio</span>
          <input className="input" value={draft.addon.name} onChange={(event) => update((value) => ({ ...value, addon: { ...value.addon, name: event.target.value } }))} />
        </label>
        <label className="field"><span>Public address (optional)</span>
          <input className="input mono" placeholder="http://10.0.0.241:60700" value={draft.addon.publicUrl} onChange={(event) => update((value) => ({ ...value, addon: { ...value.addon, publicUrl: event.target.value } }))} />
          <span className="hint">Set this if you open Haul through a different address than the one Nuvio should use, e.g. a Tailscale or HTTPS domain.</span>
        </label>
      </div>
      {info && (
        <div style={{ marginTop: 16 }}>
          <span className="hint">Manifest URL (keep it private: anyone with it can stream your library)</span>
          <div className="url-box">
            <code title={info.manifestUrl}>{info.manifestUrl}</code>
            <button className="btn sm" onClick={async () => toast(await copyText(info.manifestUrl) ? 'Copied' : 'Copy failed')}><Copy size={14} />Copy</button>
            <a className="btn sm" href={info.stremioUrl}><ExternalLink size={14} />Stremio</a>
            <button className="btn sm ghost" title="Make a new private URL. The old one stops working." onClick={async () => { if (window.confirm('Create a new addon URL? You will need to reinstall it in Nuvio.')) { setInfo(await api.regenerateAddon()); toast('New addon URL created'); } }}>
              <RefreshCw size={14} />New URL
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

export function SettingsPage() {
  const toast = useToast();
  const { data, error, reload, setData } = useAsync(() => api.settings(), []);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [password, setPassword] = useState('');
  const [account, setAccount] = useState<TorboxAccount | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [folders, setFolders] = useState<Array<{ dir: string; ok: boolean; error?: string }> | null>(null);

  useEffect(() => { if (data) setDraft(data); }, [data]);
  useEffect(() => { api.testTorbox().then(setAccount, () => undefined); }, []);

  const dirty = useMemo(() => Boolean(data && draft && (JSON.stringify(data) !== JSON.stringify(draft) || apiKey || password)), [data, draft, apiKey, password]);
  if (error) return <div className="page"><ErrorNote message={error} onRetry={reload} /></div>;
  if (!draft) return <Loading />;
  const update = (patch: (value: Settings) => Settings) => setDraft((value) => (value ? patch(value) : value));

  const save = async () => {
    setSaving(true);
    try {
      const { passwordSet: _ignored, torboxApiKey: _masked, ...rest } = draft;
      const patch: SettingsPatch = { ...rest };
      if (apiKey.trim()) patch.torboxApiKey = apiKey.trim();
      if (password) patch.password = password;
      const saved = await api.saveSettings(patch);
      setData(saved);
      setApiKey('');
      setPassword('');
      if (apiKey.trim()) setAccount(await api.testTorbox());
      window.dispatchEvent(new Event('haul:refresh-status'));
      toast('Settings saved');
    } catch (failure) {
      toast((failure as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setAccount(await api.testTorbox(apiKey.trim() || undefined).catch((failure: Error) => ({ ok: false, error: failure.message })));
    setTesting(false);
  };

  const nav = [['torbox', 'TorBox'], ['folders', 'Folders'], ['quality', 'Quality'], ['sources', 'Sources'], ['downloads', 'Downloads'], ['addon', 'Nuvio addon'], ['security', 'Security']];

  return (
    <div className="page">
      <div className="page-head"><div><h1 className="page-title">Settings</h1><div className="page-sub">One place for everything. No Sonarr, Radarr or Seerr needed.</div></div></div>
      <div className="settings">
        <nav className="settings-nav">{nav.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
        <div className="stack" style={{ gap: 18 }}>
          <Section id="torbox" icon={<KeyRound size={18} />} title="TorBox" description="Haul only uses TorBox: torrents are fetched by TorBox's servers, then downloaded to this machine over HTTPS. Nothing is torrented here.">
            <div className="form-grid">
              <label className="field"><span>API key</span>
                <input className="input mono" type="password" autoComplete="off" placeholder={draft.torboxApiKey || 'Paste your TorBox API key'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
                <span className="hint">Find it at torbox.app → Settings → API key. Stored only on this server.</span>
              </label>
              <div className="field" style={{ alignContent: 'start' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>Account</span>
                <div className="row" style={{ minHeight: 40 }}>
                  {account?.ok && <span className="row" style={{ gap: 8 }}><CheckCircle2 size={17} color="var(--good)" /><span><b>{account.plan}</b> plan{account.expires ? ` · renews ${new Date(account.expires).toLocaleDateString()}` : ''}</span></span>}
                  {account && !account.ok && <span className="row" style={{ gap: 8, color: 'var(--bad)' }}><XCircle size={17} />{account.error}</span>}
                  <button className="btn sm" onClick={test} disabled={testing}>{testing ? <span className="spinner" /> : null}Test</button>
                </div>
              </div>
            </div>
          </Section>

          <Section id="folders" icon={<FolderCheck size={18} />} title="Folders" description="Paths as this server sees them. In Docker, /media is your /DATA/Media folder.">
            <div className="form-grid">
              <label className="field"><span>Movies</span><input className="input mono" value={draft.moviesDir} onChange={(event) => update((value) => ({ ...value, moviesDir: event.target.value }))} /></label>
              <label className="field"><span>TV shows</span><input className="input mono" value={draft.tvDir} onChange={(event) => update((value) => ({ ...value, tvDir: event.target.value }))} /></label>
              <label className="field"><span>In-progress downloads</span><input className="input mono" value={draft.incompleteDir} onChange={(event) => update((value) => ({ ...value, incompleteDir: event.target.value }))} />
                <span className="hint">Keep it on the same disk as your library so finished files move instantly.</span></label>
              <div className="field"><span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>Extra library folders (hosted in the addon, never written to)</span>
                <ListEditor values={draft.extraLibraryDirs} onChange={(extraLibraryDirs) => update((value) => ({ ...value, extraLibraryDirs }))} placeholder="/media/Anime" />
              </div>
            </div>
            <div className="row wrap" style={{ marginTop: 14 }}>
              <button className="btn sm" onClick={async () => setFolders((await api.checkFolders()).results)}><FolderCheck size={14} />Check folders</button>
              {folders?.map((folder) => (
                <span key={folder.dir} className={`badge ${folder.ok ? 'good' : 'bad'}`} title={folder.error}>{folder.ok ? '✓' : '✗'} {folder.dir}</span>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              <Row title="Rescan library every" description="Picks up files you add by hand. 0 turns it off.">
                <div className="row"><input className="input" type="number" min={0} style={{ width: 90 }} value={draft.library.rescanMinutes} onChange={(event) => update((value) => ({ ...value, library: { rescanMinutes: Number(event.target.value) } }))} /><span className="muted">min</span></div>
              </Row>
            </div>
          </Section>

          <Section id="quality" icon={<SlidersHorizontal size={18} />} title="Quality" description="Used to rank releases and to pick automatically when you download a whole season.">
            <Row title="Preferred resolution">
              <Segmented value={draft.quality.preferred} onChange={(preferred) => update((value) => ({ ...value, quality: { ...value.quality, preferred } }))}
                options={[{ value: '2160p', label: '4K' }, { value: '1080p', label: '1080p' }, { value: '720p', label: '720p' }, { value: 'any', label: 'Best' }]} />
            </Row>
            <Row title="Prefer instant releases" description="Strongly favour torrents TorBox already has, so downloads start immediately.">
              <Switch checked={draft.quality.preferCached} onChange={(preferCached) => update((value) => ({ ...value, quality: { ...value.quality, preferCached } }))} />
            </Row>
            <Row title="Allow HDR and Dolby Vision" description="Turn off if your TV or player shows washed-out colours.">
              <Switch checked={draft.quality.allowHdr} onChange={(allowHdr) => update((value) => ({ ...value, quality: { ...value.quality, allowHdr } }))} />
            </Row>
            <Row title="Allow AI-upscaled releases">
              <Switch checked={draft.quality.allowUpscaled} onChange={(allowUpscaled) => update((value) => ({ ...value, quality: { ...value.quality, allowUpscaled } }))} />
            </Row>
            <Row title="Size limits" description="Per episode and per movie, in GB. 0 means no limit.">
              <div className="row">
                <input className="input" type="number" min={0} style={{ width: 80 }} value={draft.quality.maxEpisodeGB} onChange={(event) => update((value) => ({ ...value, quality: { ...value.quality, maxEpisodeGB: Number(event.target.value) } }))} title="Per episode" />
                <input className="input" type="number" min={0} style={{ width: 80 }} value={draft.quality.maxMovieGB} onChange={(event) => update((value) => ({ ...value, quality: { ...value.quality, maxMovieGB: Number(event.target.value) } }))} title="Per movie" />
              </div>
            </Row>
            <label className="field" style={{ marginTop: 8 }}><span>Hide releases containing (comma separated)</span>
              <input className="input" placeholder="e.g. HDCAM, Telesync, KORSUB" value={draft.quality.blockedWords.join(', ')} onChange={(event) => update((value) => ({ ...value, quality: { ...value.quality, blockedWords: event.target.value.split(',').map((word) => word.trim()).filter(Boolean) } }))} />
            </label>
          </Section>

          <Section id="sources" icon={<Waypoints size={18} />} title="Sources" description="Where Haul looks for torrents. Results are merged, de-duplicated and checked against TorBox's cache.">
            <Row title="Torrentio" description="Scrapes the big public trackers. No account needed.">
              <Switch checked={draft.sources.torrentio} onChange={(torrentio) => update((value) => ({ ...value, sources: { ...value.sources, torrentio } }))} />
            </Row>
            {draft.sources.torrentio && (
              <label className="field" style={{ marginBottom: 10 }}><span>Torrentio address (paste a configured URL to choose providers)</span>
                <input className="input mono" value={draft.sources.torrentioUrl} onChange={(event) => update((value) => ({ ...value, sources: { ...value.sources, torrentioUrl: event.target.value } }))} />
              </label>
            )}
            <Row title="TorBox search" description="TorBox's own torrent index, using your API key.">
              <Switch checked={draft.sources.torboxSearch} onChange={(torboxSearch) => update((value) => ({ ...value, sources: { ...value.sources, torboxSearch } }))} />
            </Row>
            <div className="field" style={{ marginTop: 10 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>More Stremio torrent addons (manifest URLs that return torrents, e.g. Comet or MediaFusion without debrid)</span>
              <ListEditor values={draft.sources.addons} onChange={(addons) => update((value) => ({ ...value, sources: { ...value.sources, addons } }))} placeholder="https://…/manifest.json" />
            </div>
          </Section>

          <Section id="downloads" icon={<RefreshCw size={18} />} title="Downloads & naming" description="Files are renamed for Plex, Jellyfin and Nuvio: Show (Year)/Season 01/Show (Year) - S01E01 - Title.mkv">
            <Row title="Files at the same time" description="How many files download from TorBox to this server in parallel.">
              <input className="input" type="number" min={1} max={10} style={{ width: 80 }} value={draft.downloads.concurrentFiles} onChange={(event) => update((value) => ({ ...value, downloads: { ...value.downloads, concurrentFiles: Number(event.target.value) } }))} />
            </Row>
            <Row title="English subtitles" description="Grab matching .srt files when the torrent has them.">
              <Switch checked={draft.downloads.subtitles} onChange={(subtitles) => update((value) => ({ ...value, downloads: { ...value.downloads, subtitles } }))} />
            </Row>
            <Row title="Episode titles in file names">
              <Switch checked={draft.downloads.episodeTitles} onChange={(episodeTitles) => update((value) => ({ ...value, downloads: { ...value.downloads, episodeTitles } }))} />
            </Row>
            <Row title="Quality in file names" description='Adds " - 1080p" so different versions can sit side by side.'>
              <Switch checked={draft.downloads.qualityInName} onChange={(qualityInName) => update((value) => ({ ...value, downloads: { ...value.downloads, qualityInName } }))} />
            </Row>
            <Row title="Remove from TorBox when done" description="Frees space in your TorBox list after Haul has the files.">
              <Switch checked={draft.downloads.removeFromTorbox} onChange={(removeFromTorbox) => update((value) => ({ ...value, downloads: { ...value.downloads, removeFromTorbox } }))} />
            </Row>
          </Section>

          <AddonSection draft={draft} update={update} />

          <Section id="security" icon={<Lock size={18} />} title="Security" description="Optional password for this dashboard. The Nuvio addon keeps working with its private URL.">
            <div className="form-grid">
              <label className="field"><span>{draft.passwordSet ? 'Change password' : 'Set a password'}</span>
                <input className="input" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={draft.passwordSet ? 'New password' : 'Leave empty for no password'} />
              </label>
              {draft.passwordSet && (
                <div className="field" style={{ alignContent: 'end' }}>
                  <button className="btn danger" style={{ width: 'fit-content' }} onClick={async () => { if (window.confirm('Remove the dashboard password?')) { setData(await api.saveSettings({ password: '' })); toast('Password removed'); } }}>Remove password</button>
                </div>
              )}
            </div>
          </Section>
        </div>
      </div>
      {dirty && (
        <div className="save-bar">
          <span className="muted">You have unsaved changes</span>
          <div className="row">
            <button className="btn ghost" onClick={() => { setDraft(data ?? null); setApiKey(''); setPassword(''); }}>Discard</button>
            <button className="btn primary" onClick={save} disabled={saving}>{saving ? <span className="spinner" /> : <Save size={15} />}Save changes</button>
          </div>
        </div>
      )}
    </div>
  );
}
