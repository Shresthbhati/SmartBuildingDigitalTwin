import { useEffect, useState, useSyncExternalStore } from 'react';
import { getSession, subscribeSession } from '../api/auth';
import type { AuthSession } from '../types/nexus';

/** Wall-clock ticker so relative ages ("12s ago") and stale transitions stay current. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The current auth session (null when signed out), reactive to login/logout. */
export function useSession(): AuthSession | null {
  return useSyncExternalStore(subscribeSession, getSession, () => null);
}

/** `prefers-reduced-motion`, reactive. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return;
    }
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
