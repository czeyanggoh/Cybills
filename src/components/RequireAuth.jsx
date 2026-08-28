import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { canManageBusiness, canManageUsers } from '@/lib/userStore';
import { isPracticeTeam, canManagePractice } from '@/lib/practiceStore';

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}

// Guards the signed-in app. When real Google OAuth is enabled, unauthenticated
// visitors are bounced to /login, and signed-in users without an approved roster
// profile are sent to /join (self-signup / awaiting approval). When OAuth isn't
// configured yet (mock mode), access is allowed so the demo keeps working.
export default function RequireAuth({ children }) {
  const { loading, googleEnabled, user, membership } = useAuth();

  if (loading) return <Loading />;
  if (googleEnabled && !user) return <Navigate to="/login" replace />;

  // Membership gating only applies with real auth on — mock mode stays open.
  if (googleEnabled && user && (membership.status === 'none' || membership.status === 'pending')) {
    return <Navigate to="/join" replace />;
  }

  return children;
}

// Where a bare URL lands.
//
// The root used to redirect to /login unconditionally, so typing
// cybills.cy-bm.sg put a signed-in person on a sign-in page — which reads as
// having been logged out, and was reported as one ("can you make it save the
// session so I don't have to keep logging in"). The session was fine the whole
// time; the route simply never asked.
export function HomeRedirect() {
  const { loading, googleEnabled, user, membership } = useAuth();

  if (loading) return <Loading />;
  if (googleEnabled && !user) return <Navigate to="/login" replace />;
  // Signed in but not yet approved: /join is where they belong, and it is what
  // RequireAuth would send them to a moment later anyway.
  if (googleEnabled && user && (membership.status === 'none' || membership.status === 'pending')) {
    return <Navigate to="/join" replace />;
  }
  return <Navigate to="/costs" replace />;
}

// The sign-in page itself, which somebody already signed in has no business
// sitting on — following a stale link or a bookmark should put them back in the
// app, not in front of a form asking who they are.
export function RedirectIfSignedIn({ children }) {
  const { loading, googleEnabled, user } = useAuth();

  if (loading) return <Loading />;
  if (googleEnabled && user) return <Navigate to="/costs" replace />;
  return children;
}

// Lighter guard for the /join onboarding page: requires a signed-in user (with
// real auth) but does NOT require an approved profile — that's the whole point.
export function RequireSignedIn({ children }) {
  const { loading, googleEnabled, user } = useAuth();

  if (loading) return <Loading />;
  if (googleEnabled && !user) return <Navigate to="/login" replace />;

  return children;
}

// Shared guard for the admin pages: the same auth/membership gate as
// RequireAuth, then `allows` decides. Anyone who fails is bounced to Costs.
// Mock mode (no real auth) stays open for the demo.
function RequireAccess({ allows, children }) {
  const { loading, googleEnabled, user, membership } = useAuth();

  if (loading) return <Loading />;
  if (googleEnabled && !user) return <Navigate to="/login" replace />;
  if (googleEnabled && user && (membership.status === 'none' || membership.status === 'pending')) {
    return <Navigate to="/join" replace />;
  }
  if (!allows(membership, googleEnabled)) return <Navigate to="/costs" replace />;

  return children;
}

// The Users roster — Business Admin or User Admin.
export function RequireAdmin({ children }) {
  return <RequireAccess allows={canManageUsers}>{children}</RequireAccess>;
}

// Business settings (lists, categories, exports, extraction, email,
// connections) — Business Admin only. A User Admin runs people, not the
// business configuration.
export function RequireBusinessAdmin({ children }) {
  return <RequireAccess allows={canManageBusiness}>{children}</RequireAccess>;
}

// The practice's client list — anyone on the practice team (CYBM), since it's
// how a colleague finds the clients they work on.
export function RequirePracticeTeam({ children }) {
  return <RequireAccess allows={isPracticeTeam}>{children}</RequireAccess>;
}

// The colleague roster and client access — Owner / Practice Admin only. A
// Standard colleague does client work; they don't run the practice.
export function RequirePracticeAdmin({ children }) {
  return <RequireAccess allows={canManagePractice}>{children}</RequireAccess>;
}
