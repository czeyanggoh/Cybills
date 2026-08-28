import { useState } from 'react';
import { ShieldCheck, Copy, Check, AlertTriangle } from 'lucide-react';
import { startTotp, enableTotp, disableTotp } from '@/lib/totp';
import { cn } from '@/lib/utils';

// Two-step sign-in for the password login.
//
// A Google account already carries its own second factor, so this is for the
// people who reach CYBills through the password form — ST Engineering's staff,
// and anyone else without a Google account. For them the password is otherwise
// the only thing between an outsider and a client's whole book of paperwork.
//
// Enrolment is deliberately three moves: take the secret, prove the app has it,
// then keep the recovery codes. Nothing about signing in changes until the
// middle one succeeds, so a person who wanders off halfway is not locked out.

function Mono({ children }) {
  return <span className="font-mono text-sm tracking-wide">{children}</span>;
}

function CopyButton({ value, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors hover:bg-muted"
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? 'Copied' : label}
    </button>
  );
}

export default function TwoFactorSetup({ enabled, recoveryCodesLeft = 0, onChanged }) {
  const [step, setStep] = useState('idle'); // idle | setup | codes | off
  const [secret, setSecret] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const begin = async () => {
    setBusy(true);
    setError('');
    try {
      setSecret(await startTotp());
      setStep('setup');
    } catch {
      setError('Could not start. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const out = await enableTotp(code.trim());
      setCodes(out.recoveryCodes || []);
      setCode('');
      setStep('codes');
      onChanged?.();
    } catch {
      setError('That code is not right. Check the app and try the next one.');
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setError('');
    try {
      await disableTotp(code.trim());
      setCode('');
      setStep('idle');
      onChanged?.();
    } catch {
      setError('That code is not right.');
    } finally {
      setBusy(false);
    }
  };

  const input =
    'h-10 w-full max-w-[12rem] rounded-md border bg-background px-3 text-center font-mono text-base tracking-[0.3em] outline-none focus-visible:ring-2 focus-visible:ring-ring';

  // --- Freshly enrolled: the codes, shown once ---------------------------------
  if (step === 'codes') {
    return (
      <div className="space-y-3 rounded-lg border border-amber-600/30 bg-amber-50 p-4 dark:bg-amber-500/10">
        <p className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4" /> Save these recovery codes now
        </p>
        <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
          Only their fingerprints are kept, so this is the one time they can be read. Each works once, and
          they are the way back in if the phone is lost. Without them, only an admin can reset it.
        </p>
        <div className="grid grid-cols-2 gap-1.5 rounded-md border bg-background p-3 sm:grid-cols-3">
          {codes.map((c) => (
            <Mono key={c}>{c}</Mono>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={codes.join('\n')} label="Copy all" />
          <button
            type="button"
            onClick={() => setStep('idle')}
            className="inline-flex h-8 items-center rounded-md bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90"
          >
            I have saved them
          </button>
        </div>
      </div>
    );
  }

  // --- Enrolling ---------------------------------------------------------------
  if (step === 'setup' && secret) {
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p className="text-sm font-medium">Add CYBills to your authenticator</p>
        <p className="text-xs text-muted-foreground">
          Google Authenticator, 1Password, Authy — any of them. Add an account by hand and type this key in.
        </p>
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
          <Mono>{secret.readable}</Mono>
          <span className="flex-1" />
          <CopyButton value={secret.secret} label="Copy key" />
        </div>
        {/* On a phone this opens the authenticator directly; on a laptop it does
            nothing, which is why the key above is the main path rather than a
            fallback. */}
        <a
          href={secret.uri}
          className="inline-block text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Or open it in an app on this device
        </a>
        <div className="border-t pt-3">
          <p className="mb-2 text-sm">Then enter the 6-digit code it shows:</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={code}
              onChange={(e) => { setCode(e.target.value); setError(''); }}
              placeholder="123456"
              inputMode="numeric"
              className={input}
            />
            <button
              type="button"
              onClick={confirm}
              disabled={busy || !code.trim()}
              className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Checking…' : 'Turn on'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('idle'); setError(''); }}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          <p className="mt-2 text-xs text-muted-foreground">
            Nothing changes about signing in until this code checks out.
          </p>
        </div>
      </div>
    );
  }

  // --- Turning it off ----------------------------------------------------------
  if (step === 'off') {
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p className="text-sm font-medium">Turn off two-step sign-in</p>
        <p className="text-xs text-muted-foreground">
          Enter a current code to confirm it is you — a signed-in browser somebody walked away from should not
          be able to take this off on its own.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={code}
            onChange={(e) => { setCode(e.target.value); setError(''); }}
            placeholder="123456"
            inputMode="numeric"
            className={input}
          />
          <button
            type="button"
            onClick={turnOff}
            disabled={busy || !code.trim()}
            className="inline-flex h-10 items-center rounded-md border border-destructive px-4 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Turn off'}
          </button>
          <button
            type="button"
            onClick={() => { setStep('idle'); setCode(''); setError(''); }}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  // --- Idle --------------------------------------------------------------------
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium">
          Two-step sign-in
          {enabled ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-600/30 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10">
              <ShieldCheck className="h-3 w-3" /> On
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">Off</span>
          )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {enabled ? (
            <>
              A code from your authenticator is asked for after your password.
              {recoveryCodesLeft ? ` ${recoveryCodesLeft} recovery code${recoveryCodesLeft === 1 ? '' : 's'} left.` : ' No recovery codes left — turn it off and on again to get a new set.'}
            </>
          ) : (
            <>Ask for a code from your phone as well as your password. Signing in with Google instead? Google already does this.</>
          )}
        </p>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      <button
        type="button"
        onClick={() => (enabled ? setStep('off') : begin())}
        disabled={busy}
        className={cn(
          'inline-flex h-9 shrink-0 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50'
        )}
      >
        {busy ? 'Starting…' : enabled ? 'Turn off' : 'Set up'}
      </button>
    </div>
  );
}
