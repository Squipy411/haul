import { useState } from 'react';
import { api } from '../api';

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="gate">
      <form
        className="gate-inner"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try { await api.login(password); onDone(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
        }}
      >
        <div className="brand"><img src="/icon.svg" alt="" />HAUL</div>
        <h1>Sign in</h1>
        <label className="field"><span>Password</span><input className="input" type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {error && <div className="note bad">{error}</div>}
        <div><button className="btn primary lg" disabled={!password || busy}>{busy && <span className="spinner" />}Sign in</button></div>
      </form>
    </div>
  );
}
