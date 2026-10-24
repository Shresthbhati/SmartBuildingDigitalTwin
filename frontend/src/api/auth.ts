import type { AuthSession, Role } from '../types/nexus';

// The session lives in localStorage for convenience only; every access is wrapped because
// storage can be blocked (private windows, embedded previews) and the app must still work.
const KEY = 'nexus.session';
const listeners = new Set<() => void>();

export const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

// Memoised by raw string so `getSession` returns a stable reference (needed by
// useSyncExternalStore) until the stored value actually changes.
let cached: { raw: string | null; session: AuthSession | null } = { raw: null, session: null };

export function getSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === cached.raw && (cached.session === null || cached.session.expiresAt > Date.now())) {
      return cached.session;
    }
    let session: AuthSession | null = null;
    if (raw) {
      const parsed = JSON.parse(raw) as AuthSession;
      if (parsed.token && parsed.expiresAt > Date.now()) session = parsed;
      else localStorage.removeItem(KEY);
    }
    cached = { raw: session ? raw : null, session };
    return session;
  } catch {
    return null;
  }
}

export function setSession(session: AuthSession | null): void {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the session just won't survive a reload */
  }
  listeners.forEach(l => l());
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hasRole(session: AuthSession | null, minimum: Role): boolean {
  return !!session && ROLE_RANK[session.role] >= ROLE_RANK[minimum];
}

/** Fired by the API layer when a request needs (more) authority than the session has. */
export const AUTH_REQUIRED_EVENT = 'nexus:auth-required';
