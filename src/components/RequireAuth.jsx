import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { canManageBusiness, canManageUsers } from '@/lib/userStore';

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
