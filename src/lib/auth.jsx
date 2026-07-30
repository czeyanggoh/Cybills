import { createContext, useContext, useEffect, useState, useCallback } from 'react';

// App-wide auth state. Loads once: whether real Google OAuth is configured on
// the backend (`googleEnabled`) and the current signed-in user (or null).
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [loading, setLoading] = useState(true);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [user, setUser] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [statusRes, meRes] = await Promise.all([
        fetch('/api/auth/status'),
        fetch('/api/auth/me'),
      ]);
      if (statusRes.ok) {
        const s = await statusRes.json();
        setGoogleEnabled(Boolean(s.googleEnabled));
        setVisionEnabled(Boolean(s.visionEnabled));
      }
      setUser(meRes.ok ? (await meRes.json()).user : null);
    } catch {
      // Backend unreachable — treat as signed-out, mock mode.
      setGoogleEnabled(false);
      setVisionEnabled(false);
      setUser(null);
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
    <AuthContext.Provider value={{ loading, googleEnabled, visionEnabled, user, refresh, signOut, loginWithPassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
