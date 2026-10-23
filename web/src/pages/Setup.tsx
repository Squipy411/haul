import { useEffect, useState } from 'react';
import type { TorboxAccount } from '../../../shared/types';
import { api } from '../api';
import { useToast } from '../lib';

export function Setup({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [apiKey, setApiKey] = useState('');
  const [account, setAccount] = useState<TorboxAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [moviesDir, setMoviesDir] = useState('');
  const [tvDir, setTvDir] = useState('');

  useEffect(() => {
    api.settings().then((value) => { setMoviesDir(value.moviesDir); setTvDir(value.tvDir); }, () => undefined);
  }, []);

  const finish = async () => {
    setBusy(true);
    try {
      const result = await api.testTorbox(apiKey.trim());
      setAccount(result);
      if (!result.ok) return;
      await api.saveSettings({ torboxApiKey: apiKey.trim(), moviesDir, tvDir });
      const broken = (await api.checkFolders()).results.filter((folder) => !folder.ok);
      if (broken.length) toast(`Can't write to ${broken.map((folder) => folder.dir).join(', ')}. Fix it in Settings.`, 'error');
      onDone();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-inner" onSubmit={(event) => { event.preventDefault(); void finish(); }}>
        <div className="brand"><img src="/icon.svg" alt="" />HAUL</div>
        <h1>Connect TorBox</h1>
        <ol>
          <li>Paste your TorBox API key. Torrents run on TorBox, never on this server.</li>
          <li>Check where films and series should be saved.</li>
          <li>Later, add the addon URL from Library to Nuvio.</li>
        </ol>
        <label className="field">
          <span>API key</span>
          <input className="input mono" type="password" autoComplete="off" autoFocus value={apiKey} onChange={(event) => { setApiKey(event.target.value); setAccount(null); }} />
          <a className="hint" href="https://torbox.app/settings" target="_blank" rel="noreferrer">Find it at torbox.app/settings ↗</a>
        </label>
        {account && (account.ok
          ? <div className="note info">Connected · {account.plan} plan</div>
          : <div className="note bad">{account.error}</div>)}
        <div className="form-grid">
          <label className="field"><span>Films folder</span><input className="input mono" value={moviesDir} onChange={(event) => setMoviesDir(event.target.value)} /></label>
          <label className="field"><span>Series folder</span><input className="input mono" value={tvDir} onChange={(event) => setTvDir(event.target.value)} /></label>
        </div>
        <div><button className="btn primary lg" disabled={!apiKey.trim() || busy}>{busy && <span className="spinner" />}Connect</button></div>
      </form>
    </div>
  );
}
