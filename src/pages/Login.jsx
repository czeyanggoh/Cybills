import { useNavigate } from 'react-router-dom';
import { Receipt } from 'lucide-react';
import { cn } from '@/lib/utils';

// Google "G" rendered monochrome to fit the black & white house style (the
// four-colour mark would break the minimalist aesthetic).
function GoogleIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M23 12.25c0-.83-.07-1.6-.2-2.35H12v4.45h6.16a5.27 5.27 0 0 1-2.28 3.46v2.87h3.68C21.68 18.66 23 15.7 23 12.25Zm-11 11c3.08 0 5.66-1.02 7.55-2.77l-3.68-2.87c-1.02.69-2.33 1.1-3.87 1.1-2.98 0-5.5-2.01-6.4-4.71H1.9v2.96A11.4 11.4 0 0 0 12 23.25Zm-6.4-6.7A6.85 6.85 0 0 1 5.24 14c0-.9.16-1.77.36-2.55V8.49H1.9a11.36 11.36 0 0 0 0 10.22l3.7-2.16Zm6.4-9.28c1.68 0 3.19.58 4.38 1.71l3.26-3.26C17.66 1.6 15.08.75 12 .75A11.4 11.4 0 0 0 1.9 8.49l3.7 2.96c.9-2.7 3.42-4.7 6.4-4.7Z" />
    </svg>
  );
}

// Login screen. Auth isn't wired yet, so both actions just route into the app
// (mock sign-in) — swap for real Google OAuth / email flows later.
export default function Login() {
  const navigate = useNavigate();
  const signIn = () => navigate('/costs');

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border">
            <Receipt className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Sign in to CYBills</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your billing workspace
            </p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            signIn();
          }}
          className="flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Email</span>
            <input
              type="email"
              required
              placeholder="you@company.com"
              className="h-10 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <button
            type="submit"
            className="h-10 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Continue
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>

        <button
          type="button"
          onClick={signIn}
          className={cn(
            'flex h-10 w-full items-center justify-center gap-2.5 rounded-md border',
            'bg-background text-sm font-medium transition-colors hover:bg-muted'
          )}
        >
          <GoogleIcon className="h-4 w-4" />
          Continue with Google
        </button>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          By continuing you agree to the CYBills terms of use.
        </p>
      </div>
    </div>
  );
}
