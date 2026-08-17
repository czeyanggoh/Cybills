import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Receipt } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import { requestPasswordReset } from '@/lib/userStore';

// Google "G" rendered monochrome to fit the black & white house style (the
// four-colour mark would break the minimalist aesthetic).
function GoogleIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M23 12.25c0-.83-.07-1.6-.2-2.35H12v4.45h6.16a5.27 5.27 0 0 1-2.28 3.46v2.87h3.68C21.68 18.66 23 15.7 23 12.25Zm-11 11c3.08 0 5.66-1.02 7.55-2.77l-3.68-2.87c-1.02.69-2.33 1.1-3.87 1.1-2.98 0-5.5-2.01-6.4-4.71H1.9v2.96A11.4 11.4 0 0 0 12 23.25Zm-6.4-6.7A6.85 6.85 0 0 1 5.24 14c0-.9.16-1.77.36-2.55V8.49H1.9a11.36 11.36 0 0 0 0 10.22l3.7-2.16Zm6.4-9.28c1.68 0 3.19.58 4.38 1.71l3.26-3.26C17.66 1.6 15.08.75 12 .75A11.4 11.4 0 0 0 1.9 8.49l3.7 2.96c.9-2.7 3.42-4.7 6.4-4.7Z" />
    </svg>
  );
}

// Maps the ?error= codes the OAuth callback may redirect back with.
const ERROR_MESSAGES = {
  bad_state: 'Sign-in session expired. Please try again.',
  domain_not_allowed: 'That account isn’t allowed to sign in here.',
  email_unverified: 'Your Google email isn’t verified.',
  exchange_failed: 'Google sign-in failed. Please try again.',
  google_oauth_not_configured: 'Google sign-in isn’t configured yet.',
};

export default function Login() {
  const navigate = useNavigate();
  const { googleEnabled, mailEnabled, loginWithPassword } = useAuth();
  const [params] = useSearchParams();
  const error = params.get('error');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetNote, setResetNote] = useState('');

  // Real OAuth when configured; otherwise a mock sign-in straight into the app.
  const continueWithGoogle = () => {
    if (googleEnabled) {
      window.location.href = '/api/auth/google';
    } else {
      navigate('/costs');
    }
  };

  // Non-Google sign-in — for staff whose Google account Google blocks.
  const submitPassword = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password || busy) return;
    setBusy(true);
    setPwError('');
    try {
      const ok = await loginWithPassword(email.trim(), password);
      if (ok) navigate('/costs');
      else setPwError('Wrong email or password.');
    } catch {
      setPwError('Could not sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  // "Forgot password?" — emails a single-use reset link. The confirmation is
  // deliberately vague about whether the address has an account (the server
  // answers identically either way), so this can't be used to probe the roster.
  const sendReset = async () => {
    const addr = email.trim();
    if (!addr) {
      setPwError('Enter your email address first, then choose Forgot password.');
      return;
    }
    setBusy(true);
    setPwError('');
    await requestPasswordReset(addr);
    setBusy(false);
    setResetNote(`If ${addr} has a CYBills account, a reset link is on its way. It expires in a few days.`);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border">
            <Receipt className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Sign in to CYBills</h1>
            <p className="mt-1 text-sm text-muted-foreground">Your billing workspace</p>
          </div>
        </div>

        {error && (
          <p className="mb-4 rounded-md border border-foreground/20 bg-muted px-3 py-2 text-center text-xs text-foreground">
            {ERROR_MESSAGES[error] ?? 'Something went wrong. Please try again.'}
          </p>
        )}

        <button
          type="button"
          onClick={continueWithGoogle}
          className={cn(
            'flex h-11 w-full items-center justify-center gap-2.5 rounded-md border',
            'bg-background text-sm font-medium transition-colors hover:bg-muted'
          )}
        >
          <GoogleIcon className="h-4 w-4" />
          Continue with Google
        </button>

        <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
          <div className="h-px flex-1 bg-border" /> or <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={submitPassword} className="space-y-2.5">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="username"
            className="h-11 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            className="h-11 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          {pwError && <p className="text-center text-xs text-destructive">{pwError}</p>}
          {resetNote && (
            <p className="rounded-md border bg-muted px-3 py-2 text-center text-xs text-muted-foreground">{resetNote}</p>
          )}
          <button
            type="submit"
            disabled={busy || !email.trim() || !password}
            className="h-11 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {/* Only offered once outbound email is configured — without a mailer
              there'd be nothing to send, and an admin has to reset by hand. */}
          {mailEnabled && (
            <button
              type="button"
              onClick={sendReset}
              disabled={busy}
              className="w-full pt-1 text-center text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
            >
              Forgot password?
            </button>
          )}
        </form>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          By continuing you agree to the CYBills terms of use.
        </p>
      </div>
    </div>
  );
}
