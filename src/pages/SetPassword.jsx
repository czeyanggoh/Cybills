import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Receipt, CheckCircle2 } from 'lucide-react';
import { checkResetToken, acceptReset } from '@/lib/userStore';
import { useAuth } from '@/lib/auth';

// Landing page for the single-use link in an invitation or password-reset
// email (/set-password?token=…). Public by design: the whole point is that the
// recipient can't sign in yet. The token is validated first so an expired link
// says so plainly instead of failing only after the form is filled in.
export default function SetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const token = params.get('token') || '';

  const [state, setState] = useState({ status: 'checking' }); // checking | valid | invalid
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setState({ status: 'invalid' });
      return undefined;
    }
    checkResetToken(token).then((res) => {
      if (cancelled) return;
      setState(res?.valid ? { status: 'valid', ...res } : { status: 'invalid' });
    });
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirm) return setError('Passwords don’t match.');
    setBusy(true);
    setError('');
    const res = await acceptReset(token, password);
    if (!res.ok) {
      setBusy(false);
      setError(
        res.error === 'invalid_or_expired'
          ? 'This link has expired or has already been used.'
          : res.error === 'weak_password'
            ? 'Password must be at least 8 characters.'
            : 'Could not set your password. Please try again.'
      );
      return;
    }
    // The server signed us in as part of accepting the link — pick up the new
    // session before entering the app so the guards see it.
    await refresh();
    navigate('/costs', { replace: true });
  };

  const input =
    'h-11 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border">
            <Receipt className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              {state.status === 'valid' && state.kind === 'invite' ? 'Welcome to CYBills' : 'Choose a new password'}
            </h1>
            {state.status === 'valid' && (
              <p className="mt-1 text-sm text-muted-foreground">
                {state.kind === 'invite'
                  ? `Set a password to activate ${state.email}.`
                  : `Setting a new password for ${state.email}.`}
              </p>
            )}
          </div>
        </div>

        {state.status === 'checking' && (
          <p className="text-center text-sm text-muted-foreground">Checking your link…</p>
        )}

        {state.status === 'invalid' && (
          <div className="space-y-4 text-center">
            <p className="rounded-md border bg-muted px-3 py-3 text-sm">
              This link is no longer valid. Invitation and reset links expire, and can only be used
              once.
            </p>
            <p className="text-xs text-muted-foreground">
              Ask an administrator to send a new invitation, or request a fresh reset link from the
              sign-in page.
            </p>
            <Link
              to="/login"
              className="inline-flex h-11 w-full items-center justify-center rounded-md border text-sm font-medium transition-colors hover:bg-muted"
            >
              Back to sign in
            </Link>
          </div>
        )}

        {state.status === 'valid' && (
          <form onSubmit={submit} className="space-y-2.5">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password"
              autoComplete="new-password"
              className={input}
            />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm new password"
              autoComplete="new-password"
              className={input}
            />
            {error && <p className="text-center text-xs text-destructive">{error}</p>}
            <button
              type="submit"
              disabled={busy || !password || !confirm}
              className="h-11 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Set password and sign in'}
            </button>
            <p className="flex items-center justify-center gap-1.5 pt-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5" /> At least 8 characters.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
