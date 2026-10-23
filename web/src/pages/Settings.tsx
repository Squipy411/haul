import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { encode } from 'uqr';
import type { AddonInfo, Settings, SettingsPatch, Status, TorboxAccount } from '../../../shared/types';
import { api } from '../api';
import { ErrorNote, Loading, Picker, Toggle } from '../components/ui';
import { copyText, useAsync, useToast } from '../lib';

function Section({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-row">
      <header><h2>{title}</h2><p>{description}</p></header>
      <div className="panel">{children}</div>
    </section>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function SwitchRow({ title, description, checked, onChange }: { title: string; description?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="switch-row">
      <b>{title}</b>
      <Toggle checked={checked} onChange={onChange} label={title} />
      {description && <small>{description}</small>}
    </div>
  );
}

function ListEditor({ id, values, onChange, placeholder }: { id: string; values: string[]; onChange: (values: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const add = () => { if (draft.trim()) { onChange([...values, draft.trim()]); setDraft(''); } };
  return (
    <div className="stack" style={{ gap: 8 }}>
      {values.map((value, index) => (
        <div key={`${index}-${value}`} className="row" style={{ gap: 8 }}>
          <input className="input code" value={value} aria-label={`Entry ${index + 1}`} onChange={(event) => onChange(values.map((item, position) => (position === index ? event.target.value : item)))} />
          <button className="btn sm danger" onClick={() => onChange(values.filter((_, position) => position !== index))}>Remove</button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <input id={id} className="input code" placeholder={placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button className="btn sm" onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
    </div>
  );
}

/** A QR code for the phone to scan, drawn as one SVG path. */
function QrCode({ text, size = 132 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const { data } = encode(text, { border: 2 });
    let d = '';
    data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
    return { d, size: data.length };
  }, [text]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label="QR code for the notification topic" shapeRendering="crispEdges">
      <rect width={path.size} height={path.size} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

const newTopic = () => `haul-${Array.from(crypto.getRandomValues(new Uint8Array(9)), (byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 16)}`; // taste-skill-ignore: random bytes, not labels
const DISCORD = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//;

function PasswordSection({ passwordSet }: { passwordSet: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.status().then(setStatus, () => undefined); }, [passwordSet]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      setCurrent('');
      setNext('');
      toast(done);
      window.dispatchEvent(new Event('haul:settings-changed'));
    } catch (failure) {
      toast((failure as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Password"
      description={status?.desktop
        ? 'The app signs its own window in. Set a password to open Haul from a phone or another computer.'
        : 'Anyone who opens Haul needs it. Changing it signs out every other device; the Nuvio addon keeps working.'}
    >
      <div className="two">
        {passwordSet && (
          <Field id="pw-current" label="Current password">
            <input id="pw-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
          </Field>
        )}
        <Field id="pw-next" label={passwordSet ? 'New password' : 'Password'} hint="At least 8 characters">
          <input id="pw-next" className="input" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />
        </Field>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy || next.length < 8 || (passwordSet && !current)} onClick={() => run(() => api.changePassword(current, next), passwordSet ? 'Password changed' : 'Password set')}>
          {passwordSet ? 'Change password' : 'Set password'}
        </button>
        {passwordSet && status?.canRemovePassword && <button className="btn danger" disabled={busy || !current} onClick={() => run(() => api.changePassword(current, null), 'Password removed')}>Remove password</button>}
        <span className="grow" />
        {passwordSet && !status?.desktop && <button className="btn ghost" onClick={async () => { await api.logout(); window.location.assign('/'); }}>Sign out</button>}
      </div>
    </Section>
  );
}

const number = (value: string) => (value === '' ? 0 : Number(value));

export function SettingsPage() {
  const toast = useToast();
  const { data, error, reload, setData } = useAsync(() => api.settings(), []);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [account, setAccount] = useState<TorboxAccount | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [folders, setFolders] = useState<Array<{ dir: string; ok: boolean; error?: string }> | null>(null);
  const [addon, setAddon] = useState<AddonInfo | null>(null);
  const [player, setPlayer] = useState<{ ffmpeg: boolean } | null>(null);

  useEffect(() => { if (data) setDraft(data); }, [data]);
  useEffect(() => {
    api.testTorbox().then(setAccount, () => undefined);
    api.addon().then(setAddon, () => undefined);
    api.playInfo().then(setPlayer, () => undefined);
  }, []);
  useEffect(() => {
    const refresh = () => { api.settings().then(setData, () => undefined); };
    window.addEventListener('haul:settings-changed', refresh);
    return () => window.removeEventListener('haul:settings-changed', refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(() => Boolean(data && draft && (JSON.stringify(data) !== JSON.stringify(draft) || apiKey)), [data, draft, apiKey]);
  if (error) return <div className="canvas"><ErrorNote message={error} onRetry={reload} /></div>;
  if (!draft) return <Loading />;
  const set = (patch: (value: Settings) => Settings) => setDraft((value) => (value ? patch(value) : value));
  const setNotify = (patch: Partial<Settings['notifications']>) => set((value) => ({ ...value, notifications: { ...value.notifications, ...patch } }));
  const topicUrl = `${draft.notifications.ntfyServer.replace(/\/+$/, '')}/${draft.notifications.ntfyTopic}`;

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const { passwordSet: _passwordSet, torboxApiKey: _masked, ...rest } = draft;
      const patch: SettingsPatch = { ...rest };
      if (apiKey.trim()) patch.torboxApiKey = apiKey.trim();
      setData(await api.saveSettings(patch));
      setApiKey('');
      if (patch.torboxApiKey) setAccount(await api.testTorbox());
      setAddon(await api.addon());
      window.dispatchEvent(new Event('haul:refresh-status'));
      toast('Settings saved');
      return true;
    } catch (failure) {
      toast((failure as Error).message, 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setNotifying(true);
    try {
      if (dirty && !(await save())) return;
      await api.testNotification();
      toast('Test sent. It should be on your phone now.');
    } catch (failure) {
      toast((failure as Error).message, 'error');
    } finally {
      setNotifying(false);
    }
  };

  const check = async () => {
    setTesting(true);
    setAccount(await api.testTorbox(apiKey.trim() || undefined).catch((failure: Error) => ({ ok: false, error: failure.message })));
    setTesting(false);
  };

  return (
    <div className="canvas">
      <div className="title-row"><h1>Settings</h1></div>
      <div className="settings">
        <Section title="TorBox" description="TorBox downloads the torrents on its own servers. Haul then fetches the finished files over HTTPS, so this machine never joins a swarm.">
          <div className="switch-row">
            <b>{account?.ok ? `${account.plan} plan` : account ? 'Not connected' : 'Checking…'}</b>
            <button className="btn sm" onClick={check} disabled={testing}>{testing && <span className="spinner" />}Check</button>
            <small>{account?.ok ? (account.expires ? `Renews ${new Date(account.expires).toLocaleDateString()}` : 'Connected') : account?.error ?? ''}</small>
          </div>
          <div className="divider" />
          <Field id="torbox-key" label="API key" hint={`The saved key ends in ${draft.torboxApiKey.slice(-4) || '…'}. Paste a new one from torbox.app/settings to replace it.`}>
            <input id="torbox-key" className="input code" type="password" autoComplete="off" placeholder="New API key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          </Field>
        </Section>

        <Section title="Folders" description="Where films and episodes are saved. In Docker these paths are inside the container, usually under /media.">
          <div className="two">
            <Field id="dir-movies" label="Movies"><input id="dir-movies" className="input code" value={draft.moviesDir} onChange={(event) => set((value) => ({ ...value, moviesDir: event.target.value }))} /></Field>
            <Field id="dir-tv" label="Shows"><input id="dir-tv" className="input code" value={draft.tvDir} onChange={(event) => set((value) => ({ ...value, tvDir: event.target.value }))} /></Field>
          </div>
          <Field id="dir-incomplete" label="Downloads in progress" hint="Keep it on the same drive as your library so finished files move instantly.">
            <input id="dir-incomplete" className="input code" value={draft.incompleteDir} onChange={(event) => set((value) => ({ ...value, incompleteDir: event.target.value }))} />
          </Field>
          <Field id="dir-extra" label="Other folders to include" hint="They appear in your library and the Nuvio addon. Haul never writes to them.">
            <ListEditor id="dir-extra" values={draft.extraLibraryDirs} onChange={(extraLibraryDirs) => set((value) => ({ ...value, extraLibraryDirs }))} placeholder="/media/Anime" />
          </Field>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={async () => setFolders((await api.checkFolders()).results)}>Test write access</button>
            {folders && (folders.every((folder) => folder.ok)
              ? <span className="pill positive">All folders are writable</span>
              : <span className="pill negative">Can't write to {folders.filter((folder) => !folder.ok).map((folder) => folder.dir).join(', ')}</span>)}
            <span className="grow" />
            <label htmlFor="rescan" className="muted">Check for new files every</label>
            <input id="rescan" className="input num" type="number" min={0} style={{ width: 72, height: 32 }} value={draft.library.rescanMinutes} onChange={(event) => set((value) => ({ ...value, library: { rescanMinutes: number(event.target.value) } }))} />
            <span className="muted">min</span>
          </div>
        </Section>

        <Section title="Quality" description="How versions are ranked, and what “Download season” picks on its own.">
          <div className="switch-row">
            <b>Preferred resolution</b>
            <Picker label="Preferred resolution" value={draft.quality.preferred} onChange={(preferred) => set((value) => ({ ...value, quality: { ...value.quality, preferred } }))}
              options={[{ value: '2160p', label: '4K' }, { value: '1080p', label: '1080p' }, { value: '720p', label: '720p' }, { value: 'any', label: 'Highest available' }]} />
          </div>
          <div className="divider" />
          <SwitchRow title="Prefer versions that are ready now" description="TorBox already has them, so they start right away." checked={draft.quality.preferCached} onChange={(preferCached) => set((value) => ({ ...value, quality: { ...value.quality, preferCached } }))} />
          <SwitchRow title="Prefer bigger files" description="Among equal versions, the larger file wins. Bigger usually means a better encode." checked={draft.quality.preferLarger} onChange={(preferLarger) => set((value) => ({ ...value, quality: { ...value.quality, preferLarger } }))} />
          <SwitchRow title="Allow HDR and Dolby Vision" description="Turn off if colours look washed out on your TV." checked={draft.quality.allowHdr} onChange={(allowHdr) => set((value) => ({ ...value, quality: { ...value.quality, allowHdr } }))} />
          <SwitchRow title="Allow AI-upscaled versions" checked={draft.quality.allowUpscaled} onChange={(allowUpscaled) => set((value) => ({ ...value, quality: { ...value.quality, allowUpscaled } }))} />
          <div className="divider" />
          <div className="two">
            <Field id="q-ep" label="Largest episode, GB" hint="0 means no limit"><input id="q-ep" className="input num" type="number" min={0} value={draft.quality.maxEpisodeGB} onChange={(event) => set((value) => ({ ...value, quality: { ...value.quality, maxEpisodeGB: number(event.target.value) } }))} /></Field>
            <Field id="q-movie" label="Largest movie, GB" hint="0 means no limit"><input id="q-movie" className="input num" type="number" min={0} value={draft.quality.maxMovieGB} onChange={(event) => set((value) => ({ ...value, quality: { ...value.quality, maxMovieGB: number(event.target.value) } }))} /></Field>
          </div>
          <Field id="q-blocked" label="Hide versions containing" hint="Separate words with commas, for example HDCAM, KORSUB">
            <input id="q-blocked" className="input" value={draft.quality.blockedWords.join(', ')} onChange={(event) => set((value) => ({ ...value, quality: { ...value.quality, blockedWords: event.target.value.split(',').map((word) => word.trim()).filter(Boolean) } }))} />
          </Field>
        </Section>

        <Section title="Where to look" description="Torrents from every source are combined and checked against TorBox in one go.">
          <SwitchRow title="Torrentio" description="Public trackers. No account needed." checked={draft.sources.torrentio} onChange={(torrentio) => set((value) => ({ ...value, sources: { ...value.sources, torrentio } }))} />
          {draft.sources.torrentio && (
            <Field id="s-torrentio-url" label="Torrentio address" hint="Paste a configured Torrentio link to choose providers. Leave out debrid options.">
              <input id="s-torrentio-url" className="input code" value={draft.sources.torrentioUrl} onChange={(event) => set((value) => ({ ...value, sources: { ...value.sources, torrentioUrl: event.target.value } }))} />
            </Field>
          )}
          <SwitchRow title="TorBox search" description="TorBox's own index, using your key." checked={draft.sources.torboxSearch} onChange={(torboxSearch) => set((value) => ({ ...value, sources: { ...value.sources, torboxSearch } }))} />
          <Field id="s-addons" label="Other Stremio addons" hint="Any addon that lists torrents, such as Comet or MediaFusion without debrid. Paste its manifest address.">
            <ListEditor id="s-addons" values={draft.sources.addons} onChange={(addons) => set((value) => ({ ...value, sources: { ...value.sources, addons } }))} placeholder="https://…/manifest.json" />
          </Field>
        </Section>

        <Section title="Downloading" description={<>Files are named for Plex, Jellyfin and Nuvio, for example <span style={{ color: 'var(--text)' }}>Breaking Bad (2008) / Season 01 / Breaking Bad (2008) - S01E04 - Cancer Man - 1080p.mkv</span></>}>
          <div className="two">
            <Field id="d-parallel" label="Files at once" hint="How many files download to this machine at the same time.">
              <input id="d-parallel" className="input num" type="number" min={1} max={10} style={{ width: 90 }} value={draft.downloads.concurrentFiles} onChange={(event) => set((value) => ({ ...value, downloads: { ...value.downloads, concurrentFiles: number(event.target.value) } }))} />
            </Field>
            <Field id="d-connections" label="Connections per file" hint="TorBox caps the speed of each connection, so big files download in parts at once. Use 1 if downloads fail.">
              <input id="d-connections" className="input num" type="number" min={1} max={8} style={{ width: 90 }} value={draft.downloads.connections} onChange={(event) => set((value) => ({ ...value, downloads: { ...value.downloads, connections: number(event.target.value) } }))} />
            </Field>
          </div>
          <div className="divider" />
          <SwitchRow title="English subtitles" description="Saves matching .srt files next to the video." checked={draft.downloads.subtitles} onChange={(subtitles) => set((value) => ({ ...value, downloads: { ...value.downloads, subtitles } }))} />
          <SwitchRow title="Episode titles in file names" checked={draft.downloads.episodeTitles} onChange={(episodeTitles) => set((value) => ({ ...value, downloads: { ...value.downloads, episodeTitles } }))} />
          <SwitchRow title="Resolution in file names" description="Lets two versions of an episode sit side by side." checked={draft.downloads.qualityInName} onChange={(qualityInName) => set((value) => ({ ...value, downloads: { ...value.downloads, qualityInName } }))} />
          <SwitchRow title="Remove from TorBox when finished" description="Keeps your TorBox list tidy." checked={draft.downloads.removeFromTorbox} onChange={(removeFromTorbox) => set((value) => ({ ...value, downloads: { ...value.downloads, removeFromTorbox } }))} />
        </Section>

        <Section title="Notifications" description="Haul tells your phone the moment a torrent is out for something you follow, not when it airs. It checks every 5 minutes on the day an episode comes out.">
          <SwitchRow title="Send notifications" description="Off until you turn it on. Alerts go to the ntfy topic below and to Discord, if you add a webhook." checked={draft.notifications.enabled} onChange={(enabled) => setNotify({ enabled })} />
          <div className="divider" />
          <div className="phone-setup">
            <QrCode text={topicUrl} />
            <ol>
              <li>Install <b>ntfy</b> on your phone. It's free on the App Store and Google Play.</li>
              <li>Tap <b>+</b> and subscribe to <code>{draft.notifications.ntfyTopic}</code>{draft.notifications.ntfyServer !== 'https://ntfy.sh' && <> on <code>{draft.notifications.ntfyServer}</code></>}, or scan the code with your camera.</li>
              <li>Turn on notifications, then send a test.</li>
            </ol>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn sm primary" onClick={sendTest} disabled={notifying || !draft.notifications.enabled}>{notifying && <span className="spinner" />}Send a test notification</button>
            <button className="btn sm" onClick={async () => toast(await copyText(draft.notifications.ntfyTopic) ? 'Topic copied' : 'Copy failed')}>Copy topic</button>
            <button className="btn sm ghost" onClick={() => setNotify({ ntfyTopic: newTopic() })}>New topic</button>
          </div>
          <div className="divider" />
          <div className="two">
            <Field id="n-topic" label="Topic" hint="Anyone who knows the topic can read it, so keep it long and random.">
              <input id="n-topic" className="input code" value={draft.notifications.ntfyTopic} onChange={(event) => setNotify({ ntfyTopic: event.target.value.replace(/[^a-zA-Z0-9_-]/g, '') })} />
            </Field>
            <Field id="n-server" label="ntfy server" hint="Keep ntfy.sh unless you run your own. On iPhone, your own server needs upstream-base-url set to deliver instantly.">
              <input id="n-server" className="input code" value={draft.notifications.ntfyServer} onChange={(event) => setNotify({ ntfyServer: event.target.value })} />
            </Field>
          </div>
          <div className="two">
            <Field id="n-token" label="Access token" hint="Only for a server with sign-in. Leave empty for ntfy.sh.">
              <input id="n-token" className="input code" type="password" autoComplete="off" value={draft.notifications.ntfyToken} onChange={(event) => setNotify({ ntfyToken: event.target.value })} />
            </Field>
            <Field id="n-discord" label="Discord webhook" hint={draft.notifications.discordWebhook && !DISCORD.test(draft.notifications.discordWebhook) ? <span style={{ color: 'var(--negative)' }}>This isn't a Discord webhook address.</span> : 'Optional. Sends the same alerts to a Discord channel.'}>
              <input id="n-discord" className="input code" placeholder="https://discord.com/api/webhooks/…" value={draft.notifications.discordWebhook} onChange={(event) => setNotify({ discordWebhook: event.target.value })} />
            </Field>
          </div>
          <div className="divider" />
          <SwitchRow title="When a download finishes" checked={draft.notifications.downloadFinished} onChange={(downloadFinished) => setNotify({ downloadFinished })} />
          <SwitchRow title="When a download fails" checked={draft.notifications.downloadFailed} onChange={(downloadFailed) => setNotify({ downloadFailed })} />
        </Section>

        <Section title="Watching" description="Press play on any title or episode. Haul plays your own file when it has one, and otherwise streams the best version TorBox already has.">
          <div className="switch-row">
            <b>Streaming from TorBox</b>
            <span className={`pill ${account?.ok && /pro/i.test(account.plan ?? '') ? 'positive' : ''}`}>{account?.ok ? `${account.plan} plan` : 'Not connected'}</span>
            <small>TorBox converts every format for the browser on its servers. Its streaming needs a Pro plan.</small>
          </div>
          <div className="switch-row">
            <b>Your own files</b>
            <span className={`pill ${player?.ffmpeg ? 'positive' : 'warning'}`}>{player ? (player.ffmpeg ? 'Every format' : 'MP4 and WebM only') : 'Checking…'}</span>
            <small>{player?.ffmpeg
              ? 'ffmpeg is installed, so MKV, x265, DTS and TrueHD files are converted on the fly. 4K is converted to 1080p when the browser can’t play it.'
              : 'Install ffmpeg on this machine to play MKV, x265 and Dolby/DTS audio in the browser. The Docker image includes it.'}</small>
          </div>
        </Section>

        <Section title="Nuvio and Stremio" description="Your library as an addon. Anyone with the address can play your files, so keep it private.">
          <SwitchRow title="Share my library as an addon" checked={draft.addon.enabled} onChange={(enabled) => set((value) => ({ ...value, addon: { ...value.addon, enabled } }))} />
          <div className="two">
            <Field id="a-name" label="Name in Nuvio"><input id="a-name" className="input" value={draft.addon.name} onChange={(event) => set((value) => ({ ...value, addon: { ...value.addon, name: event.target.value } }))} /></Field>
            <Field id="a-public" label="Address for streams" hint="Only if Nuvio reaches Haul at another address, such as Tailscale or a domain.">
              <input id="a-public" className="input code" placeholder="http://192.168.1.20:60700" value={draft.addon.publicUrl} onChange={(event) => set((value) => ({ ...value, addon: { ...value.addon, publicUrl: event.target.value } }))} />
            </Field>
          </div>
          {addon && (
            <div className="field">
              <span className="field-label">Addon address</span>
              <div className="url" title={addon.manifestUrl}>{addon.manifestUrl}</div>
              <div className="row">
                <button className="btn sm" onClick={async () => toast(await copyText(addon.manifestUrl) ? 'Addon address copied' : 'Copy failed')}>Copy</button>
                <button className="btn sm ghost" onClick={async () => { if (!window.confirm('Make a new addon address? The current one stops working, and Nuvio will need the new one.')) return; setAddon(await api.regenerateAddon()); toast('New address made. Add it to Nuvio again.'); }}>Make a new address</button>
              </div>
            </div>
          )}
        </Section>

        <PasswordSection passwordSet={draft.passwordSet} />
      </div>

      {dirty && (
        <div className="savebar">
          <span className="muted">You have unsaved changes</span>
          <div className="row">
            <button className="btn ghost" onClick={() => { setDraft(data ?? null); setApiKey(''); }}>Discard</button>
            <button className="btn primary" onClick={() => void save()} disabled={saving}>{saving && <span className="spinner" />}Save changes</button>
          </div>
        </div>
      )}
    </div>
  );
}
