import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';

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

// Lighter guard for the /join onboarding page: requires a signed-in user (with
// real auth) but does NOT require an approved profile — that's the whole point.
export function RequireSignedIn({ children }) {
  const { loading, googleEnabled, user } = useAuth();

  if (loading) return <Loading />;
  if (googleEnabled && !user) return <Navigate to="/login" replace />;

  return children;
}

// Admin-only pages (Users, Business settings). Runs the same auth/membership
// gate as RequireAuth, then requires a Business/User Admin role; non-admins are
// bounced to Costs. Mock mode (no real auth) stays open for the demo.
export function RequireAdmin({ children }) {
  const { loading, googleEnabled, user, membership } = useAuth();

  if (loading) return <Loading />;
  if (googleEnabled && !user) return <Navigate to="/login" replace />;
  if (googleEnabled && user && (membership.status === 'none' || membership.status === 'pending')) {
    return <Navigate to="/join" replace />;
  }

  const role = membership.user?.role;
  const isAdmin = !googleEnabled || ['Business Admin', 'User Admin'].includes(role);
  if (!isAdmin) return <Navigate to="/costs" replace />;

  return children;
}
