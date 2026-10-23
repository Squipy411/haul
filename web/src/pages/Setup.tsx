import { ArrowRight, CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Settings, TorboxAccount } from '../../../shared/types';
import { api } from '../api';
import { useToast } from '../lib';

export function Setup({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [account, setAccount] = useState<TorboxAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [moviesDir, setMoviesDir] = useState('');
  const [tvDir, setTvDir] = useState('');

  useEffect(() => {
    api.settings().then((value) => { setSettings(value); setMoviesDir(value.moviesDir); setTvDir(value.tvDir); }, () => undefined);
  }, []);

  const finish = async () => {
    setBusy(true);
    try {
      const result = await api.testTorbox(apiKey.trim());
      setAccount(result);
      if (!result.ok) return;
      await api.saveSettings({ torboxApiKey: apiKey.trim(), moviesDir, tvDir });
      const check = await api.checkFolders();
      const broken = check.results.filter((folder) => !folder.ok);
      if (broken.length) toast(`Haul can't write to ${broken.map((folder) => folder.dir).join(', ')}. You can fix this in Settings.`, 'error');
      onDone();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="splash">
      <div className="splash-card">
        <img className="logo" src="/icon.svg" alt="" />
        <div>
          <h1>Welcome to Haul</h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>Browse movies and shows, pick a season pack or a whole season, and Haul brings it to this server through TorBox, renamed and ready for Nuvio.</p>
        </div>
        <div className="steps">
          <div className="step"><b>1</b>Connect your TorBox account. All torrenting happens on TorBox's servers.</div>
          <div className="step"><b>2</b>Confirm where movies and shows should go.</div>
          <div className="step"><b>3</b>Install the Haul addon in Nuvio from the Library page.</div>
        </div>
        <label className="field">
          <span>TorBox API key</span>
          <input className="input mono" type="password" autoComplete="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setAccount(null); }} />
          <a className="hint" href="https://torbox.app/settings" target="_blank" rel="noreferrer" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>Get it from torbox.app → Settings <ExternalLink size={11} /></a>
        </label>
        {account && (account.ok
          ? <div className="notice info"><CheckCircle2 size={16} />Connected: {account.plan} plan</div>
          : <div className="notice bad"><XCircle size={16} />{account.error}</div>)}
        {settings && (
          <div className="form-grid">
            <label className="field"><span>Movies folder</span><input className="input mono" value={moviesDir} onChange={(event) => setMoviesDir(event.target.value)} /></label>
            <label className="field"><span>TV shows folder</span><input className="input mono" value={tvDir} onChange={(event) => setTvDir(event.target.value)} /></label>
          </div>
        )}
        <button className="btn primary lg" disabled={!apiKey.trim() || busy} onClick={finish}>
          {busy ? <span className="spinner" /> : null}Connect and start <ArrowRight size={17} />
        </button>
      </div>
    </div>
  );
}
