import { AUTH_REQUIRED_EVENT, hasRole } from '../api/auth';
import { useNexus } from '../store';
import type { Role } from '../types/nexus';
import { useSession } from './useNow';

/**
 * Whether the current user may perform lifecycle/scenario actions. When the server runs with
 * auth disabled (local dev) everyone can; otherwise an operator session is required.
 */
export function useCan(minimum: Role = 'operator') {
  const session = useSession();
  const authEnabled = useNexus(s => s.meta?.auth_enabled ?? true);
  return {
    allowed: !authEnabled || hasRole(session, minimum),
    authEnabled,
    session,
    promptLogin: () =>
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT, { detail: { status: 401 } })),
  };
}
