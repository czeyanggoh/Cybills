import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';

// Guards the signed-in app. When real Google OAuth is enabled, unauthenticated
// visitors are bounced to /login. When OAuth isn't configured yet (mock mode),
// access is allowed so the demo keeps working without credentials.
export default function RequireAuth({ children }) {
  const { loading, googleEnabled, user } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (googleEnabled && !user) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
