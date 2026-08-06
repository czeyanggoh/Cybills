import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { fetchMembership } from '@/lib/userStore';

// App-wide auth state. Loads once: whether real Google OAuth is configured on
// the backend (`googleEnabled`), the current signed-in user (or null), and the
// user's roster membership (`membership.status`: anonymous|none|pending|active).
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [loading, setLoading] = useState(true);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [user, setUser] = useState(null);
  const [membership, setMembership] = useState({ status: 'anonymous', user: null });

  const refresh = useCallback(async () => {
    try {
      const [statusRes, meRes, mem] = await Promise.all([
        fetch('/api/auth/status'),
        fetch('/api/auth/me'),
        fetchMembership(),
      ]);
      if (statusRes.ok) {
        const s = await statusRes.json();
        setGoogleEnabled(Boolean(s.googleEnabled));
        setVisionEnabled(Boolean(s.visionEnabled));
      }
      setUser(meRes.ok ? (await meRes.json()).user : null);
      setMembership(mem || { status: 'anonymous', user: null });
    } catch {
      // Backend unreachable — treat as signed-out, mock mode.
      setGoogleEnabled(false);
      setVisionEnabled(false);
      setUser(null);
      setMembership({ status: 'anonymous', user: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
    }
  }, []);

  // Non-Google sign-in (email + password). Resolves true on success.
  const loginWithPassword = useCallback(async (email, password) => {
    const res = await fetch('/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return false;
    const { user: u } = await res.json();
    setUser(u || null);
    return true;
  }, []);

  return (
    <AuthContext.Provider value={{ loading, googleEnabled, visionEnabled, user, membership, refresh, signOut, loginWithPassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
