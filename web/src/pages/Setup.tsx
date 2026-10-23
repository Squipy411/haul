import { useEffect, useState } from 'react';
import { SERVICE_INFO, SERVICE_NAMES } from '../../../shared/services';
import type { DebridService } from '../../../shared/types';
import { api } from '../api';
import { ServicePicker } from '../components/ServicePicker';
import { Mark } from '../components/ui';
import { useToast } from '../lib';

export function Setup({ createPassword, onDone }: { createPassword: boolean; onDone: () => void }) {
  const toast = useToast();
  const [service, setService] = useState<DebridService>('torbox');
  const [apiKey, setApiKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [moviesDir, setMoviesDir] = useState('');
  const [tvDir, setTvDir] = useState('');

  useEffect(() => {
    api.setupDefaults().then((value) => { setMoviesDir(value.moviesDir); setTvDir(value.tvDir); }, () => undefined);
  }, []);

  const finish = async () => {
    setError('');
    if (createPassword && password.length < 8) return setError('Choose a password of at least 8 characters.');
    if (createPassword && password !== confirm) return setError('The two passwords are different.');
    setBusy(true);
    try {
      await api.setup({ service, torboxApiKey: apiKey.trim(), moviesDir, tvDir, password: createPassword ? password : undefined });
      const broken = (await api.checkFolders()).results.filter((folder) => !folder.ok);
      if (broken.length) toast(`Haul can't save to ${broken.map((folder) => folder.dir).join(', ')}. Fix the folder permissions, then check Settings.`, 'error');
      onDone();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={(event) => { event.preventDefault(); void finish(); }}>
        <div className="wordmark"><Mark size={26} /><span className="lockup"><b>Haul</b><small>Stream &amp; download</small></span></div>
        <h1>{createPassword ? 'Set up Haul' : 'Connect your service'}</h1>
        <p>Haul is your own streaming site. It plays films and shows straight from a debrid service (TorBox, Real-Debrid, AllDebrid or Premiumize), plays your own files, and downloads the ones you want to keep, named for Plex, Jellyfin and Nuvio.</p>
        {createPassword && (
          <div className="panel">
            <div className="two">
              <div className="field"><label htmlFor="setup-pw">Password</label><input id="setup-pw" className="input" type="password" autoComplete="new-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} /><span className="hint">At least 8 characters. Anyone who opens Haul needs it.</span></div>
              <div className="field"><label htmlFor="setup-pw2">Type it again</label><input id="setup-pw2" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></div>
            </div>
          </div>
        )}
        <div className="panel">
          <div className="field">
            <span className="field-label">Your debrid service</span>
            <ServicePicker value={service} onChange={(next) => { setService(next); setApiKey(''); }} />
          </div>
          <div className="field">
            <label htmlFor="setup-key">{SERVICE_NAMES[service]} API key</label>
            <input id="setup-key" className="input code" type="password" autoComplete="off" autoFocus={!createPassword} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            <span className="hint">Find it at <a href={SERVICE_INFO[service].keyUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>{SERVICE_INFO[service].keyPage}</a>. It stays on this machine.</span>
          </div>
          <div className="two">
            <div className="field"><label htmlFor="setup-movies">Movies folder</label><input id="setup-movies" className="input code" value={moviesDir} onChange={(event) => setMoviesDir(event.target.value)} /></div>
            <div className="field"><label htmlFor="setup-tv">Shows folder</label><input id="setup-tv" className="input code" value={tvDir} onChange={(event) => setTvDir(event.target.value)} /></div>
          </div>
        </div>
        {error && <div className="notice negative">{error}</div>}
        <div><button className="btn primary" disabled={!apiKey.trim() || busy}>{busy && <span className="spinner" />}{createPassword ? 'Finish setup' : 'Connect'}</button></div>
      </form>
    </div>
  );
}
