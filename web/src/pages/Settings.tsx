import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { encode } from 'uqr';
import type { AddonInfo, Settings, SettingsPatch, Status, TorboxAccount } from '../../../shared/types';
import { api } from '../api';
import { ErrorNote, Loading, Picker, Sheet, Toggle } from '../components/ui';
import { ProfilesEditor } from '../components/Profiles';
import { copyText, useAsync, useToast } from '../lib';
import { useStatus } from '../shell';

function Section({ title, description, children, id }: { title: string; description: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="settings-row" id={id}>
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
function QrCode({ text, size = 132, label = 'QR code for the notification topic' }: { text: string; size?: number; label?: string }) {
  const path = useMemo(() => {
    const { data } = encode(text, { border: 2 });
    let d = '';
    data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
    return { d, size: data.length };
  }, [text]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={path.size} height={path.size} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

const newTopic = () => `haul-${Array.from(crypto.getRandomValues(new Uint8Array(9)), (byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 16)}`; // taste-skill-ignore: random bytes, not labels
const DISCORD = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//;

const REMOTE_GUIDE = 'https://github.com/Squipy411/haul#use-haul-from-anywhere';

/** Turning on two-step sign-in: the password again, then a QR code to scan and the first code to confirm. */
function TwoFactorSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; url: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await action(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const start = () => run(async () => { setSetup(await api.twoFactorStart(password)); setPassword(''); });
  const confirm = () => run(async () => {
    await api.twoFactorConfirm(code.replace(/\s/g, ''));
    toast('Two-step sign-in is on');
    onDone();
    onClose();
  });
  return (
    <Sheet
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="Set up two-step sign-in"
      description="Signing in will also ask for a 6-digit code from an authenticator app on your phone: Google Authenticator, Microsoft Authenticator, 1Password, or the iPhone's Passwords app."
      footer={setup
        ? <><span className="hint">Codes change every 30 seconds.</span><button className="btn primary" disabled={busy || code.replace(/\s/g, '').length !== 6} onClick={confirm}>{busy && <span className="spinner" />}Turn on</button></>
        : <><span /><button className="btn primary" disabled={busy || !password} onClick={start}>{busy && <span className="spinner" />}Continue</button></>}
    >
      {!setup ? (
        <form onSubmit={(event) => { event.preventDefault(); if (password) void start(); }}>
          <Field id="tf-password" label="Your Haul password">
            <input id="tf-password" className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
        </form>
      ) : (
        <div className="two-factor-setup">
          <a href={setup.url} aria-label="Open in an authenticator app on this device"><QrCode text={setup.url} size={180} label="QR code to add Haul to an authenticator app" /></a>
          <ol className="steps">
            <li>In the authenticator app, add an account and scan this code. On a phone, tap the code instead.</li>
            <li>No camera? Enter this key by hand: <span className="code-key">{setup.secret.match(/.{1,4}/g)!.join(' ')}</span> <button className="btn ghost sm" onClick={async () => { if (await copyText(setup.secret)) toast('Key copied'); }}>Copy</button></li>
            <li>
              <Field id="tf-code" label="Type the code the app shows">
                <input id="tf-code" className="input code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123 456" autoFocus value={code} onChange={(event) => setCode(event.target.value.replace(/[^0-9 ]/g, ''))} onKeyDown={(event) => { if (event.key === 'Enter' && code.replace(/\s/g, '').length === 6) void confirm(); }} />
              </Field>
            </li>
          </ol>
        </div>
      )}
      {error && <div className="notice negative" role="alert" style={{ marginTop: 12 }}>{error}</div>}
    </Sheet>
  );
}

const settingsChanged = () => window.dispatchEvent(new Event('haul:settings-changed'));

function SecuritySection({ passwordSet, twoFactor }: { passwordSet: boolean; twoFactor: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [offPassword, setOffPassword] = useState('');
  const [offCode, setOffCode] = useState('');
  useEffect(() => { api.status().then(setStatus, () => undefined); }, [passwordSet, twoFactor]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      setCurrent('');
      setNext('');
      setOffPassword('');
      setOffCode('');
      setTurningOff(false);
      toast(done);
      settingsChanged();
    } catch (failure) {
      toast((failure as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const access = status?.access;
  const host = window.location.host;
  return (
    <Section
      title="Sign-in and security"
      description={status?.desktop
        ? 'The app signs its own window in. Set a password to open Haul from a phone or another computer.'
        : <>Anyone who opens Haul needs the password. To open Haul from anywhere, give it a free HTTPS address with Tailscale Funnel: <a href={REMOTE_GUIDE} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>how to</a>.</>}
    >
      {access && (
        access.fromInternet && !access.https
          ? <div className="notice negative">You're reaching Haul from the internet without HTTPS, so your password travels unencrypted. Use a tunnel such as Tailscale Funnel instead of opening a port.</div>
          : access.fromInternet
            ? <div className={`notice ${twoFactor ? 'positive' : 'warning'}`}>Connected from the internet over HTTPS ({host}).{twoFactor ? ' Two-step sign-in is on.' : ' Turn on two-step sign-in below, so a password alone can\'t get in.'}</div>
            : <div className="notice">Connected on your own network{access.https ? ' over HTTPS' : ''} ({host}).</div>
      )}

      <div className="two">
        {passwordSet && (
          <Field id="pw-current" label="Current password">
            <input id="pw-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
          </Field>
        )}
        <Field id="pw-next" label={passwordSet ? 'New password' : 'Password'} hint="At least 8 characters; 12 or more if Haul is reachable from the internet. Changing it signs out every other device; the Nuvio addon keeps working.">
          <input id="pw-next" className="input" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />
        </Field>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" disabled={busy || next.length < 8 || (passwordSet && !current)} onClick={() => run(() => api.changePassword(current, next), passwordSet ? 'Password changed' : 'Password set')}>
          {passwordSet ? 'Change password' : 'Set password'}
        </button>
        {passwordSet && status?.canRemovePassword && !twoFactor && <button className="btn danger" disabled={busy || !current} onClick={() => run(() => api.changePassword(current, null), 'Password removed')}>Remove password</button>}
      </div>

      {passwordSet && (
        <>
          <div className="switch-row">
            <b>Two-step sign-in</b>
            {twoFactor
              ? <button className="btn sm" onClick={() => setTurningOff((value) => !value)} aria-expanded={turningOff}>Turn off</button>
              : <button className="btn sm" onClick={() => setSettingUp(true)}>Set up</button>}
            <small>{twoFactor ? 'On. Signing in asks for the password and a code from your authenticator app.' : 'Signing in also asks for a 6-digit code from an app on your phone. Worth turning on before Haul is reachable from the internet.'}</small>
          </div>
          {turningOff && (
            <div className="two">
              <Field id="tf-off-password" label="Password">
                <input id="tf-off-password" className="input" type="password" autoComplete="current-password" value={offPassword} onChange={(event) => setOffPassword(event.target.value)} />
              </Field>
              <Field id="tf-off-code" label="Code from the app">
                <input id="tf-off-code" className="input code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={offCode} onChange={(event) => setOffCode(event.target.value.replace(/[^0-9 ]/g, ''))} />
              </Field>
              <div><button className="btn danger" disabled={busy || !offPassword || offCode.replace(/\s/g, '').length !== 6} onClick={() => run(() => api.twoFactorOff(offPassword, offCode.replace(/\s/g, '')), 'Two-step sign-in is off')}>Turn off two-step sign-in</button></div>
            </div>
          )}
          <div className="switch-row">
            <b>Signed in somewhere you shouldn't be?</b>
            <button className="btn sm" disabled={busy} onClick={() => run(() => api.endOtherSessions(), 'Every other device is signed out')}>Sign out everywhere else</button>
            <small>Ends every session except this one. Phones and browsers need the password again.</small>
          </div>
        </>
      )}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="grow" />
        {passwordSet && !status?.desktop && <button className="btn ghost" onClick={async () => { await api.logout(); window.location.assign('/'); }}>Sign out</button>}
      </div>
      {settingUp && <TwoFactorSheet onClose={() => setSettingUp(false)} onDone={settingsChanged} />}
    </Section>
  );
}

const number = (value: string) => (value === '' ? 0 : Number(value));

export function SettingsPage() {
  const toast = useToast();
  const status = useStatus();
  // Opened from the profile menu: go straight to Profiles.
  useEffect(() => { if (window.location.hash === '#profiles') window.setTimeout(() => document.getElementById('profiles')?.scrollIntoView({ block: 'start' }), 400); }, []);
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
          <SwitchRow title="New sign-ins" description="Each time a device signs in, and when an address is paused for wrong passwords." checked={draft.notifications.signIns} onChange={(signIns) => setNotify({ signIns })} />
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

        <Section id="profiles" title="Profiles" description="Everyone in the house can have their own Continue watching, My list and watched episodes. The library, downloads and settings are shared. With two or more, Haul asks who's watching on each browser.">
          <ProfilesEditor profiles={status?.profiles ?? []} current={status?.profile ?? null} onChange={() => window.dispatchEvent(new Event('haul:refresh-status'))} />
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

        <SecuritySection passwordSet={draft.passwordSet} twoFactor={draft.twoFactor} />
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
