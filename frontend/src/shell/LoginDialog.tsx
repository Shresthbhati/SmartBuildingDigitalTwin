import { useEffect, useRef, useState } from 'react';
import { AUTH_REQUIRED_EVENT } from '../api/auth';
import { authApi, errorMessage } from '../api/client';

/** Opens whenever the API layer reports a 401/403, or the user chooses "Sign in". */
export function LoginDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(AUTH_REQUIRED_EVENT, show);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, show);
  }, []);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await authApi.login(String(form.get('username')), String(form.get('password')));
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="login-title"
      onClose={() => setOpen(false)}
    >
      <form onSubmit={submit} className="form-stack">
        <h2 id="login-title">Sign in</h2>
        <p className="dim">
          Operators can acknowledge and resolve items, run scenarios and inject demo events.
        </p>
        <label>
          Username
          <input name="username" autoComplete="username" required autoFocus />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && (
          <div className="state-banner error" role="alert">
            {error}
          </div>
        )}
        <div className="row end">
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
