import { Lock } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="splash">
      <form
        className="splash-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try { await api.login(password); onDone(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
        }}
      >
        <img className="logo" src="/icon.svg" alt="" />
        <div><h1>Haul</h1><p className="muted" style={{ margin: '6px 0 0' }}>Enter your dashboard password.</p></div>
        <label className="field"><span>Password</span><input className="input" type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error && <div className="notice bad">{error}</div>}
        <button className="btn primary lg" disabled={!password || busy}>{busy ? <span className="spinner" /> : <Lock size={16} />}Sign in</button>
      </form>
    </div>
  );
}
