import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { fetchMembership } from '@/lib/userStore';
import { ORGANISATION_EVENT } from '@/lib/organisations';

// App-wide auth state. Loads once: which backend capabilities are configured
// (`googleEnabled`, `visionEnabled`, `mailEnabled`), which document readers have
// an API key on the server (`readerProviders`, `defaultReaderProvider` — see
// lib/readerProvider.js), the current signed-in user (or null), and the user's
// roster membership (`membership.status`: anonymous|none|pending|active).
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [loading, setLoading] = useState(true);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [readerProviders, setReaderProviders] = useState([]);
  const [defaultReaderProvider, setDefaultReaderProvider] = useState('claude');
  const [mailEnabled, setMailEnabled] = useState(false);
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
        setReaderProviders(Array.isArray(s.readerProviders) ? s.readerProviders : []);
        setDefaultReaderProvider(s.defaultReaderProvider || 'claude');
        setMailEnabled(Boolean(s.mailEnabled));
      }
      setUser(meRes.ok ? (await meRes.json()).user : null);
      // A failed roster lookup ('error') is not evidence of being signed out —
      // keep the last known membership rather than downgrading to anonymous,
      // which would hide Users + Business settings from an admin mid-session.
      if (mem && mem.status !== 'error') setMembership(mem);
    } catch {
      // Backend unreachable — treat as signed-out, mock mode.
      setGoogleEnabled(false);
      setVisionEnabled(false);
      setReaderProviders([]);
      setMailEnabled(false);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Access is answered per client entity, so switching one re-asks the server
    // rather than carrying the previous entity's verdict across.
    window.addEventListener(ORGANISATION_EVENT, refresh);
    // Re-ask when a tab regains focus, so an identity that changed elsewhere
    // (e.g. a duplicate roster row was cleaned up) can't leave one tab stuck on
    // a stale membership — which would wrongly hide Users / Colleagues / Clients.
    const onFocus = () => refresh();
    const onVisible = () => { if (!document.hidden) refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(ORGANISATION_EVENT, refresh);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
    }
  }, []);

  // Non-Google sign-in (email + password). Resolves true on success.
  // Returns true when the password alone was enough, or `{ totpRequired,
  // challenge }` when a second factor stands in front of the session. The
  // challenge is not a session and carries nothing of its own — it says only
  // "this password was right, for this person", and expires in five minutes.
  const loginWithPassword = useCallback(async (email, password) => {
    const res = await fetch('/api/users/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data?.totpRequired) return { totpRequired: true, challenge: data.challenge };
    // Nobody signs in with a password alone: somebody who has never set a
    // second factor up is sent to do it now, before any session exists.
    if (data?.totpSetupRequired) return { totpSetupRequired: true, challenge: data.challenge };
    setUser(data?.user || null);
    return true;
  }, []);

  // The second step: a six-digit code from the authenticator, or one of the
  // recovery codes for the phone that is in a drawer somewhere.
  const loginWithCode = useCallback(async (challenge, code, trust = false) => {
    const res = await fetch('/api/users/login/totp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge, code, trust }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: data?.error || 'invalid_code' };
    setUser(data?.user || null);
    return { ok: true, usedRecoveryCode: Boolean(data?.usedRecoveryCode), recoveryCodesLeft: data?.recoveryCodesLeft };
  }, []);

  // Enrolling at the sign-in form, for somebody who has proved their password
  // and has no second factor yet. The challenge stands in for the session they
  // do not have; finishing it is what gives them one.
  const enrolAtSignIn = useCallback(async (challenge, code, trust = false) => {
    const res = await fetch('/api/users/totp/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge, code, trust }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: data?.error || 'invalid_code' };
    // Deliberately NOT setUser here. The session cookie is already set — the
    // server did that — but the moment this context knows about it, the guard
    // on /login sends the page to the app, and the recovery codes go with it.
    // They exist in readable form exactly once, so the page shows them first
    // and calls refresh() when the person says they have them.
    return { ok: true, recoveryCodes: data?.recoveryCodes ?? [] };
  }, []);

  return (
    <AuthContext.Provider
      value={{
        loading,
        googleEnabled,
        visionEnabled,
        readerProviders,
        defaultReaderProvider,
        mailEnabled,
        user,
        membership,
        refresh,
        signOut,
        loginWithPassword,
        loginWithCode,
        enrolAtSignIn,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
