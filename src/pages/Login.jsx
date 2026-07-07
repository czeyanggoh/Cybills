import { useState } from 'react';
import { Receipt } from 'lucide-react';
import { cn } from '@/lib/utils';

// Official Google "G" mark, used on the sign-in button per Google's branding
// guidelines (the four-colour logo on a white/neutral button).
function GoogleIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}

// Stubbed login page. The "Continue with Google" button is intentionally not
// wired to a real OAuth flow yet — it surfaces a "coming soon" notice so the
// page can ship while the Google Cloud OAuth client + backend exchange are set
// up later. Swap `handleGoogle` for the real redirect once creds exist.
export default function Login() {
  const [notice, setNotice] = useState(false);

  function handleGoogle() {
    // TODO: replace with real Google OAuth (redirect to /api/auth/google or
    // the Google Identity Services flow) once a Client ID is configured.
    setNotice(true);
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-muted/30 p-6">
      <div className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-sm">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex items-center gap-2">
            <Receipt className="h-7 w-7 text-primary" />
            <span className="text-xl font-semibold tracking-tight">CYBills</span>
          </div>
          <h1 className="mt-2 text-lg font-medium">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            Welcome back — sign in to your billing workspace.
          </p>
        </div>

        <button
          type="button"
          onClick={handleGoogle}
          className={cn(
            'mt-6 flex w-full items-center justify-center gap-3 rounded-md border',
            'bg-background px-4 py-2.5 text-sm font-medium',
            'transition-colors hover:bg-accent focus-visible:outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
          )}
        >
          <GoogleIcon className="h-5 w-5" />
          Continue with Google
        </button>

        {notice && (
          <p className="mt-4 rounded-md bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
            Google sign-in isn’t wired up yet — coming soon.
          </p>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          By continuing you agree to the CYBills terms of use.
        </p>
      </div>
    </div>
  );
}
