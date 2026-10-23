import { useState } from 'react';
import { api } from '../api';
import { Mark } from '../components/ui';

export function Login({ onDone, desktop, passwordSet, twoFactor }: { onDone: () => void; desktop: boolean; passwordSet: boolean; twoFactor: boolean }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (desktop && !passwordSet) {
    return (
      <div className="gate">
        <div className="gate-card">
          <div className="wordmark"><Mark size={26} /><span className="lockup"><b>Haul</b><small>Stream &amp; download</small></span></div>
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
          try {
            await api.login(password, twoFactor ? code : undefined);
            onDone();
          } catch (failure) {
            setError((failure as Error).message);
            // A code is good for one sign-in, so a failed attempt clears it for the next one.
            setCode('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="wordmark"><Mark size={26} /><span className="lockup"><b>Haul</b><small>Stream &amp; download</small></span></div>
        <h1>Sign in</h1>
        <div className="panel">
          <div className="field"><label htmlFor="login-password">Password</label><input id="login-password" className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} /></div>
          {twoFactor && (
            <div className="field">
              <label htmlFor="login-code">Code from your authenticator app</label>
              <input id="login-code" className="input code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} placeholder="123 456" value={code} onChange={(event) => setCode(event.target.value.replace(/[^0-9 ]/g, ''))} />
            </div>
          )}
        </div>
        {error && <div className="notice negative" role="alert">{error}</div>}
        <div><button className="btn primary" disabled={!password || (twoFactor && code.replace(/\s/g, '').length !== 6) || busy}>{busy && <span className="spinner" />}Sign in</button></div>
      </form>
    </div>
  );
}
