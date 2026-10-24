import { useCan } from '../lib/useAuth';
import { useNexus } from '../store';
import type { LifecycleStatus } from '../types/nexus';

/**
 * Acknowledge / resolve. Nothing changes on screen until the backend confirms: the buttons
 * show a busy state while the request is in flight, and a failure is reported, not hidden.
 */
export function LifecycleActions({
  kind,
  id,
  status,
}: {
  kind: 'alert' | 'anomaly';
  id: number;
  status: LifecycleStatus;
}) {
  const { allowed, promptLogin } = useCan('operator');
  const pendingAck = useNexus(s => !!s.pending[`${kind}:${id}:ack`]);
  const pendingResolve = useNexus(s => !!s.pending[`${kind}:${id}:resolve`]);
  const error = useNexus(s =>
    s.actionError?.key.startsWith(`${kind}:${id}:`) ? s.actionError.message : null
  );
  const acknowledge = useNexus(s => (kind === 'alert' ? s.acknowledgeAlert : s.acknowledgeAnomaly));
  const resolve = useNexus(s => (kind === 'alert' ? s.resolveAlert : s.resolveAnomaly));
  const dismiss = useNexus(s => s.dismissActionError);

  if (status === 'RESOLVED') return <p className="dim">Resolved. No further action.</p>;

  return (
    <div className="lifecycle-actions">
      <div className="row">
        {allowed ? (
          <>
            {status === 'OPEN' && (
              <button
                type="button"
                className="btn"
                disabled={pendingAck || pendingResolve}
                aria-busy={pendingAck}
                onClick={() => void acknowledge(id)}
              >
                {pendingAck ? 'Acknowledging…' : 'Acknowledge'}
              </button>
            )}
            <button
              type="button"
              className="btn primary"
              disabled={pendingAck || pendingResolve}
              aria-busy={pendingResolve}
              onClick={() => void resolve(id)}
            >
              {pendingResolve ? 'Resolving…' : 'Resolve'}
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={promptLogin}>
            Sign in to acknowledge or resolve
          </button>
        )}
      </div>
      {error && (
        <div className="state-banner error" role="alert">
          {error}{' '}
          <button type="button" className="link" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
