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
  const { googleEnabled, mailEnabled, loginWithPassword, loginWithCode, enrolAtSignIn, refresh } = useAuth();
  const [params] = useSearchParams();
  const error = params.get('error');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetNote, setResetNote] = useState('');
  // Set once the password is right and a second factor stands in front of the
  // session. Holding it here is what turns this form into two steps.
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');
  // Asked once, then not again on this machine — the whole reason a second
  // factor on a daily tool stays bearable. Off on a shared computer.
  const [trust, setTrust] = useState(true);
  // Set when this person has a password but no second factor yet: they set one
  // up here, before any session exists.
  const [setup, setSetup] = useState(null);
  const [codes, setCodes] = useState([]);

  const submitCode = async (e) => {
    e.preventDefault();
    setBusy(true);
    setPwError('');
    try {
      const out = await loginWithCode(challenge, code.trim(), trust);
      if (out.ok) navigate('/costs');
      // A challenge lasts five minutes. Saying so — and putting them back at
      // the password step — beats "invalid code" on a code that was right.
      else if (out.error === 'challenge_expired') {
        setChallenge('');
        setCode('');
        setPwError('That took too long — please sign in again.');
      } else setPwError('That code is not right.');
    } catch {
      setPwError('Could not sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitSetup = async (e) => {
    e.preventDefault();
    setBusy(true);
    setPwError('');
    try {
      const out = await enrolAtSignIn(challenge, code.trim(), trust);
      // The recovery codes exist in readable form exactly once, so they are
      // shown before anybody goes anywhere.
      if (out.ok) setCodes(out.recoveryCodes);
      else if (out.error === 'challenge_expired') {
        setChallenge('');
        setSetup(null);
        setCode('');
        setPwError('That took too long — please sign in again.');
      } else setPwError('That code is not right.');
    } catch {
      setPwError('Could not finish. Please try again.');
    } finally {
      setBusy(false);
    }
  };

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
      if (ok?.totpRequired) setChallenge(ok.challenge);
      else if (ok?.totpSetupRequired) {
        setChallenge(ok.challenge);
        const res = await fetch('/api/users/totp/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge: ok.challenge }),
        });
        if (res.ok) setSetup(await res.json());
        else setPwError('Could not start two-step sign-in. Please try again.');
      } else if (ok) navigate('/costs');
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

        {/* Once the password is right and a second factor stands in front of the
            session, the page becomes the second step and nothing else — putting
            the password form back under it would only invite starting over. */}
        {/* The codes, shown once and nowhere else — only their fingerprints are
            kept. Nobody is sent onward until they have been seen. */}
        {codes.length ? (
          <div className="space-y-3 text-left">
            <p className="text-center text-sm font-medium">Save these recovery codes</p>
            <p className="text-xs text-muted-foreground">
              This is the one time they can be read. Each works once, and they are the way back in if you lose
              your phone. Without them, only an admin can reset it.
            </p>
            <div className="grid grid-cols-2 gap-1.5 rounded-md border bg-muted/30 p-3 font-mono text-xs">
              {codes.map((c) => <span key={c}>{c}</span>)}
            </div>
            <button
              type="button"
              onClick={async () => { await refresh(); navigate('/costs'); }}
              className="h-11 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              I have saved them — continue
            </button>
          </div>
        ) : setup ? (
          /* First sign-in for somebody with a password and no second factor.
             They set it up here, before any session exists — a requirement that
             let people through "just this once" would be one in name only. */
          <form onSubmit={submitSetup} className="space-y-2.5 text-left">
            <p className="text-center text-sm font-medium">Set up two-step sign-in</p>
            {/* Numbered, because "add this key to an authenticator app"
                assumes somebody already knows what one is — and the first
                person to meet this screen asked what to do with it. */}
            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
              <li>Install an authenticator app on your phone — Google Authenticator, 1Password or Authy.</li>
              <li>Scan the square below with it. No camera? Add an account by hand and type the key instead.</li>
              <li>Enter the 6-digit code it shows. It changes every 30 seconds.</li>
            </ol>
            {setup.qr ? (
              <div
                className="mx-auto w-[200px] rounded-md border bg-white p-2"
                // The SVG is drawn by our own server from our own string; there
                // is no user input anywhere in it.
                dangerouslySetInnerHTML={{ __html: setup.qr }}
              />
            ) : null}
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-center font-mono text-sm tracking-wide">
              {setup.readable}
            </div>
            <input
              value={code}
              onChange={(e) => { setCode(e.target.value); setPwError(''); }}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              className="h-11 w-full rounded-md border bg-background px-3 text-center font-mono text-lg tracking-[0.3em] outline-none placeholder:tracking-normal placeholder:font-sans placeholder:text-base placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {pwError && <p className="text-center text-xs text-destructive">{pwError}</p>}
            <label className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} className="accent-black" />
              Trust this browser for 30 days
            </label>
            <button
              type="submit"
              disabled={busy || !code.trim()}
              className="h-11 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Checking…' : 'Turn on and sign in'}
            </button>
          </form>
        ) : challenge ? (
          <form onSubmit={submitCode} className="space-y-2.5">
            <p className="mb-3 text-center text-sm text-muted-foreground">
              Enter the 6-digit code from your authenticator app.
            </p>
            <input
              value={code}
              onChange={(e) => { setCode(e.target.value); setPwError(''); }}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              className="h-11 w-full rounded-md border bg-background px-3 text-center font-mono text-lg tracking-[0.3em] outline-none placeholder:tracking-normal placeholder:font-sans placeholder:text-base placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {pwError && <p className="text-center text-xs text-destructive">{pwError}</p>}
            {/* On by default: asked once, then not again on this machine. Worth
                unticking on a shared computer, which is why it is visible
                rather than assumed. */}
            <label className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} className="accent-black" />
              Trust this browser for 30 days
            </label>
            <button
              type="submit"
              disabled={busy || !code.trim()}
              className="h-11 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            {/* The phone in a drawer. Said here rather than left for somebody to
                remember they have. */}
            <p className="pt-1 text-center text-xs text-muted-foreground">
              Lost your phone? Enter one of your recovery codes instead. If those are gone too, an admin can
              reset it for you.
            </p>
            <button
              type="button"
              onClick={() => { setChallenge(''); setCode(''); setPwError(''); }}
              className="w-full text-center text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              Back
            </button>
          </form>
        ) : (
        <>
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
        </>
        )}

        <p className="mt-8 text-center text-xs text-muted-foreground">
          By continuing you agree to the CYBills terms of use.
        </p>
      </div>
    </div>
  );
}
