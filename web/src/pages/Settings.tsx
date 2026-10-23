import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { AddonInfo, Settings, SettingsPatch, TorboxAccount } from '../../../shared/types';
import { api } from '../api';
import { ErrorNote, Loading, Seg, Toggle } from '../components/ui';
import { copyText, useAsync, useToast } from '../lib';

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} className="settings-section">
      <header><h2>{title}</h2>{description && <p>{description}</p>}</header>
      <div>{children}</div>
    </section>
  );
}

function Setting({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div><b>{title}</b>{description && <small>{description}</small>}</div>
      <div style={{ flex: 'none' }}>{children}</div>
    </div>
  );
}

function ListEditor({ values, onChange, placeholder }: { values: string[]; onChange: (values: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const add = () => { if (draft.trim()) { onChange([...values, draft.trim()]); setDraft(''); } };
  return (
    <div className="list-edit">
      {values.map((value, index) => (
        <div key={`${index}-${value}`} className="item">
          <input className="input mono" value={value} onChange={(event) => onChange(values.map((item, position) => (position === index ? event.target.value : item)))} />
          <button className="btn danger" onClick={() => onChange(values.filter((_, position) => position !== index))}>Remove</button>
        </div>
      ))}
      <div className="item">
        <input className="input mono" placeholder={placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button className="btn" onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
    </div>
  );
}

const number = (value: string) => (value === '' ? 0 : Number(value));

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
  const [addon, setAddon] = useState<AddonInfo | null>(null);

  useEffect(() => { if (data) setDraft(data); }, [data]);
  useEffect(() => {
    api.testTorbox().then(setAccount, () => undefined);
    api.addon().then(setAddon, () => undefined);
  }, []);

  const dirty = useMemo(() => Boolean(data && draft && (JSON.stringify(data) !== JSON.stringify(draft) || apiKey || password)), [data, draft, apiKey, password]);
  if (error) return <div className="page"><ErrorNote message={error} onRetry={reload} /></div>;
  if (!draft) return <Loading />;
  const set = (patch: (value: Settings) => Settings) => setDraft((value) => (value ? patch(value) : value));

  const save = async () => {
    setSaving(true);
    try {
      const { passwordSet: _passwordSet, torboxApiKey: _masked, ...rest } = draft;
      const patch: SettingsPatch = { ...rest };
      if (apiKey.trim()) patch.torboxApiKey = apiKey.trim();
      if (password) patch.password = password;
      const saved = await api.saveSettings(patch);
      setData(saved);
      setApiKey('');
      setPassword('');
      if (patch.torboxApiKey) setAccount(await api.testTorbox());
      setAddon(await api.addon());
      window.dispatchEvent(new Event('haul:refresh-status'));
      toast('Saved');
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

  return (
    <div className="page">
      <div className="page-head"><div><h1 className="page-title">Settings</h1></div></div>

      <Section id="torbox" title="TorBox" description="Torrents are fetched by TorBox. This server downloads the finished files over HTTPS and never joins a swarm.">
        <div className="form-grid">
          <label className="field">
            <span>API key</span>
            <input className="input mono" type="password" autoComplete="off" placeholder={draft.torboxApiKey || 'Paste your key'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            <span className="hint">torbox.app → Settings → API key. Stored on this server only.</span>
          </label>
          <div className="field" style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
            <span className="field-label">Account</span>
            <div className="row" style={{ minHeight: 36 }}>
              {account?.ok && <span className="mono" style={{ fontSize: 12.5 }}><span className="sq ok" style={{ marginRight: 8 }} />{account.plan}{account.expires ? ` · until ${new Date(account.expires).toLocaleDateString()}` : ''}</span>}
              {account && !account.ok && <span className="bad" style={{ fontSize: 13 }}>{account.error}</span>}
              <button className="btn sm" onClick={test} disabled={testing}>{testing && <span className="spinner" />}Test</button>
            </div>
          </div>
        </div>
      </Section>

      <Section id="folders" title="Folders" description="Paths as the server sees them. In the Docker install, /media is /DATA/Media on the ThinkStation.">
        <div className="form-grid">
          <label className="field"><span>Films</span><input className="input mono" value={draft.moviesDir} onChange={(event) => set((value) => ({ ...value, moviesDir: event.target.value }))} /></label>
          <label className="field"><span>Series</span><input className="input mono" value={draft.tvDir} onChange={(event) => set((value) => ({ ...value, tvDir: event.target.value }))} /></label>
          <label className="field">
            <span>Downloads in progress</span>
            <input className="input mono" value={draft.incompleteDir} onChange={(event) => set((value) => ({ ...value, incompleteDir: event.target.value }))} />
            <span className="hint">Same disk as the library, so finished files move instantly.</span>
          </label>
          <div className="field" style={{ display: 'grid', gap: 6 }}>
            <span className="field-label">Extra folders to host (read only)</span>
            <ListEditor values={draft.extraLibraryDirs} onChange={(extraLibraryDirs) => set((value) => ({ ...value, extraLibraryDirs }))} placeholder="/media/Anime" />
          </div>
        </div>
        <div className="row wrap" style={{ marginTop: 16 }}>
          <button className="btn sm" onClick={async () => setFolders((await api.checkFolders()).results)}>Check write access</button>
          {folders?.map((folder) => (
            <span key={folder.dir} className={`tag ${folder.ok ? 'ok' : 'bad'}`} title={folder.error}>{folder.ok ? 'OK' : 'NO ACCESS'} {folder.dir}</span>
          ))}
        </div>
        <div style={{ marginTop: 18 }}>
          <Setting title="Rescan every" description="Picks up files added by hand. 0 turns it off.">
            <div className="row"><input className="input mono" type="number" min={0} style={{ width: 80 }} value={draft.library.rescanMinutes} onChange={(event) => set((value) => ({ ...value, library: { rescanMinutes: number(event.target.value) } }))} /><span className="muted mono" style={{ fontSize: 12 }}>min</span></div>
          </Setting>
        </div>
      </Section>

      <Section id="quality" title="Quality" description="Ranks releases, and decides what “Download season” picks on its own.">
        <Setting title="Preferred resolution">
          <Seg value={draft.quality.preferred} onChange={(preferred) => set((value) => ({ ...value, quality: { ...value.quality, preferred } }))}
            options={[{ value: '2160p', label: '2160P' }, { value: '1080p', label: '1080P' }, { value: '720p', label: '720P' }, { value: 'any', label: 'HIGHEST' }]} />
        </Setting>
        <Setting title="Prefer cached releases" description="Releases TorBox already has start immediately.">
          <Toggle checked={draft.quality.preferCached} onChange={(preferCached) => set((value) => ({ ...value, quality: { ...value.quality, preferCached } }))} />
        </Setting>
        <Setting title="Allow HDR and Dolby Vision" description="Turn off if your TV shows washed-out colour.">
          <Toggle checked={draft.quality.allowHdr} onChange={(allowHdr) => set((value) => ({ ...value, quality: { ...value.quality, allowHdr } }))} />
        </Setting>
        <Setting title="Allow AI-upscaled releases">
          <Toggle checked={draft.quality.allowUpscaled} onChange={(allowUpscaled) => set((value) => ({ ...value, quality: { ...value.quality, allowUpscaled } }))} />
        </Setting>
        <Setting title="Size limit" description="GB per episode and per film. 0 means no limit.">
          <div className="row">
            <input className="input mono" type="number" min={0} style={{ width: 70 }} title="Per episode" value={draft.quality.maxEpisodeGB} onChange={(event) => set((value) => ({ ...value, quality: { ...value.quality, maxEpisodeGB: number(event.target.value) } }))} />
            <input className="input mono" type="number" min={0} style={{ width: 70 }} title="Per film" value={draft.quality.maxMovieGB} onChange={(event) => set((value) => ({ ...value, quality: { ...value.quality, maxMovieGB: number(event.target.value) } }))} />
          </div>
        </Setting>
        <label className="field" style={{ marginTop: 12 }}>
          <span>Hide releases containing</span>
          <input className="input" placeholder="HDCAM, Telesync, KORSUB" value={draft.quality.blockedWords.join(', ')} onChange={(event) => set((value) => ({ ...value, quality: { ...value.quality, blockedWords: event.target.value.split(',').map((word) => word.trim()).filter(Boolean) } }))} />
        </label>
      </Section>

      <Section id="sources" title="Sources" description="Where torrents come from. Results are merged and checked against the TorBox cache in one call.">
        <Setting title="Torrentio" description="Public trackers. No account needed.">
          <Toggle checked={draft.sources.torrentio} onChange={(torrentio) => set((value) => ({ ...value, sources: { ...value.sources, torrentio } }))} />
        </Setting>
        {draft.sources.torrentio && (
          <label className="field" style={{ margin: '4px 0 14px' }}>
            <span>Torrentio address</span>
            <input className="input mono" value={draft.sources.torrentioUrl} onChange={(event) => set((value) => ({ ...value, sources: { ...value.sources, torrentioUrl: event.target.value } }))} />
            <span className="hint">Paste a configured Torrentio URL to choose providers. Leave debrid options out.</span>
          </label>
        )}
        <Setting title="TorBox search" description="TorBox’s own index, using your key.">
          <Toggle checked={draft.sources.torboxSearch} onChange={(torboxSearch) => set((value) => ({ ...value, sources: { ...value.sources, torboxSearch } }))} />
        </Setting>
        <div className="field" style={{ display: 'grid', gap: 6, marginTop: 12 }}>
          <span className="field-label">Other torrent addons (manifest URLs)</span>
          <ListEditor values={draft.sources.addons} onChange={(addons) => set((value) => ({ ...value, sources: { ...value.sources, addons } }))} placeholder="https://…/manifest.json" />
          <span className="hint">Any Stremio addon that returns torrents, such as Comet or MediaFusion without debrid.</span>
        </div>
      </Section>

      <Section id="downloads" title="Downloads" description="Files are named for Plex, Jellyfin and Nuvio, e.g. Show (2008)/Season 01/Show (2008) - S01E04 - Title - 1080p.mkv">
        <Setting title="Parallel files" description="Files downloading from TorBox at the same time.">
          <input className="input mono" type="number" min={1} max={10} style={{ width: 70 }} value={draft.downloads.concurrentFiles} onChange={(event) => set((value) => ({ ...value, downloads: { ...value.downloads, concurrentFiles: number(event.target.value) } }))} />
        </Setting>
        <Setting title="English subtitles" description="Save matching .srt files next to the video.">
          <Toggle checked={draft.downloads.subtitles} onChange={(subtitles) => set((value) => ({ ...value, downloads: { ...value.downloads, subtitles } }))} />
        </Setting>
        <Setting title="Episode titles in file names">
          <Toggle checked={draft.downloads.episodeTitles} onChange={(episodeTitles) => set((value) => ({ ...value, downloads: { ...value.downloads, episodeTitles } }))} />
        </Setting>
        <Setting title="Resolution in file names" description="Lets two versions of the same episode sit side by side.">
          <Toggle checked={draft.downloads.qualityInName} onChange={(qualityInName) => set((value) => ({ ...value, downloads: { ...value.downloads, qualityInName } }))} />
        </Setting>
        <Setting title="Remove from TorBox when done" description="Keeps your TorBox list short. Shared torrents stay until the last download using them finishes.">
          <Toggle checked={draft.downloads.removeFromTorbox} onChange={(removeFromTorbox) => set((value) => ({ ...value, downloads: { ...value.downloads, removeFromTorbox } }))} />
        </Setting>
      </Section>

      <Section id="addon" title="Nuvio addon" description="Your library as a Stremio-compatible addon. This replaces Personal Media Addon and Nuvi-Flow.">
        <Setting title="Serve the addon">
          <Toggle checked={draft.addon.enabled} onChange={(enabled) => set((value) => ({ ...value, addon: { ...value.addon, enabled } }))} />
        </Setting>
        <div className="form-grid" style={{ marginTop: 8 }}>
          <label className="field"><span>Name in Nuvio</span><input className="input" value={draft.addon.name} onChange={(event) => set((value) => ({ ...value, addon: { ...value.addon, name: event.target.value } }))} /></label>
          <label className="field">
            <span>Public address</span>
            <input className="input mono" placeholder="http://10.0.0.241:60700" value={draft.addon.publicUrl} onChange={(event) => set((value) => ({ ...value, addon: { ...value.addon, publicUrl: event.target.value } }))} />
            <span className="hint">Only needed if Nuvio reaches this server at a different address, e.g. Tailscale or a domain.</span>
          </label>
        </div>
        {addon && (
          <div style={{ marginTop: 16 }}>
            <span className="field-label">Manifest URL</span>
            <div className="row" style={{ marginTop: 6 }}>
              <code className="url grow" title={addon.manifestUrl}>{addon.manifestUrl}</code>
              <button className="btn sm" onClick={async () => toast(await copyText(addon.manifestUrl) ? 'Copied' : 'Copy failed')}>Copy</button>
              <button className="btn sm quiet" onClick={async () => { if (window.confirm('Make a new addon URL? The old one stops working and Nuvio needs the new one.')) { setAddon(await api.regenerateAddon()); toast('New addon URL made'); } }}>New URL</button>
            </div>
          </div>
        )}
      </Section>

      <Section id="security" title="Password" description="Optional. Protects this dashboard; the Nuvio addon keeps working through its private URL.">
        <div className="form-grid">
          <label className="field">
            <span>{draft.passwordSet ? 'New password' : 'Password'}</span>
            <input className="input" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={draft.passwordSet ? '' : 'None set'} />
          </label>
          {draft.passwordSet && (
            <div style={{ alignSelf: 'end' }}>
              <button className="btn danger" onClick={async () => { if (window.confirm('Remove the dashboard password?')) { setData(await api.saveSettings({ password: '' })); toast('Password removed'); } }}>Remove password</button>
            </div>
          )}
        </div>
      </Section>

      {dirty && (
        <div className="savebar">
          <span className="muted">Unsaved changes</span>
          <div className="row">
            <button className="btn quiet" onClick={() => { setDraft(data ?? null); setApiKey(''); setPassword(''); }}>Discard</button>
            <button className="btn primary" onClick={save} disabled={saving}>{saving && <span className="spinner" />}Save</button>
          </div>
        </div>
      )}
    </div>
  );
}
