import { useState } from 'react';
import { api } from '../api';
import { Mark } from '../components/ui';

export function Login({ onDone, desktop, passwordSet }: { onDone: () => void; desktop: boolean; passwordSet: boolean }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (desktop && !passwordSet) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="wordmark"><Mark />Haul</div>
          <h1>Open Haul on its PC</h1>
          <p>This Haul runs inside the Windows app. To use it from here, open the app on that PC and set a password in Settings.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="gate">
      <form
        className="gate-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try { await api.login(password); onDone(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
        }}
      >
        <div className="wordmark"><Mark />Haul</div>
        <h1>Sign in</h1>
        <div className="panel">
          <div className="field"><label htmlFor="login-password">Password</label><input id="login-password" className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} /></div>
        </div>
        {error && <div className="notice negative">{error}</div>}
        <div><button className="btn primary" disabled={!password || busy}>{busy && <span className="spinner" />}Sign in</button></div>
      </form>
    </div>
  );
}
