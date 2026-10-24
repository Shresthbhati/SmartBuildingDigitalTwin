import { useMemo, useState } from 'react';
import { BuildingScene } from '../building/BuildingScene';
import { alertTypeLabel, categoryLabel, relativeAge } from '../lib/format';
import { useNow } from '../lib/useNow';
import { EmptyState, ErrorState, LoadingState } from '../state/StateViews';
import { useNexus } from '../store';

/** Anomalies (statistical) and alerts (threshold) are listed apart, styled apart, and named apart. */
export function InvestigatePage() {
  const anomalies = useNexus(s => s.anomalies);
  const alerts = useNexus(s => s.alerts);
  const snapshot = useNexus(s => s.load.snapshot);
  const errors = useNexus(s => s.errors);
  const sel = useNexus(s => s.selection);
  const select = useNexus(s => s.select);
  const requestFocus = useNexus(s => s.requestFocus);
  const [showResolved, setShowResolved] = useState(false);
  const now = useNow(5000);

  const anomalyList = useMemo(
    () =>
      Object.values(anomalies)
        .filter(a => showResolved || a.status !== 'RESOLVED')
        .sort((a, b) => Date.parse(b.detected_at) - Date.parse(a.detected_at)),
    [anomalies, showResolved]
  );
  const alertList = useMemo(
    () =>
      Object.values(alerts)
        .filter(a => showResolved || a.status !== 'RESOLVED')
        .sort((a, b) => Date.parse(b.last_occurrence) - Date.parse(a.last_occurrence)),
    [alerts, showResolved]
  );

  return (
    <div className="page investigate">
      <aside className="event-list" aria-label="Anomalies and alerts">
        <label className="check">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={e => setShowResolved(e.target.checked)}
          />{' '}
          Include resolved
        </label>
        {snapshot === 'loading' && <LoadingState label="Loading" />}
        {snapshot === 'error' && (
          <ErrorState
            title="Couldn’t load alerts and anomalies"
            message={errors.anomalies ?? errors.alerts}
          />
        )}

        <h2 className="list-title anomaly">
          <span aria-hidden="true">σ</span> Statistical anomalies{' '}
          <span className="dim">baseline-based</span>
        </h2>
        {anomalyList.length === 0 && snapshot === 'ready' && (
          <EmptyState title="No anomalies" hint="Nothing unusual for any sensor right now." />
        )}
        <ul className="item-list">
          {anomalyList.map(a => (
            <li key={a.id}>
              <button
                type="button"
                className={`item anomaly ${sel.anomalyId === a.id ? 'selected' : ''}`}
                aria-current={sel.anomalyId === a.id}
                onClick={() => {
                  select({ room: a.room, anomalyId: a.id, alertId: null, sensor: null });
                  requestFocus({ room: a.room });
                }}
              >
                <span className="item-title">
                  <span aria-hidden="true">σ</span> {categoryLabel(a.anomaly_category)} · {a.room}
                </span>
                <span className="item-meta">
                  <span className={`badge sev ${a.severity.toLowerCase()}`}>{a.severity}</span>
                  <span className="badge">{a.status}</span>
                  <span className="dim">{relativeAge(Date.parse(a.detected_at), now)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <h2 className="list-title alert">
          <span aria-hidden="true">▲</span> Threshold alerts <span className="dim">rule-based</span>
        </h2>
        {alertList.length === 0 && snapshot === 'ready' && <EmptyState title="No alerts" />}
        <ul className="item-list">
          {alertList.map(a => (
            <li key={a.id}>
              <button
                type="button"
                className={`item alert ${sel.alertId === a.id ? 'selected' : ''}`}
                aria-current={sel.alertId === a.id}
                onClick={() => {
                  select({ room: a.room, alertId: a.id, anomalyId: null, sensor: null });
                  requestFocus({ room: a.room });
                }}
              >
                <span className="item-title">
                  <span aria-hidden="true">▲</span> {alertTypeLabel(a.alert_type)} · {a.room}
                </span>
                <span className="item-meta">
                  <span className={`badge sev ${a.severity.toLowerCase()}`}>{a.severity}</span>
                  <span className="badge">{a.status}</span>
                  <span className="dim">{relativeAge(Date.parse(a.last_occurrence), now)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="investigate-scene">
        <BuildingScene />
      </div>
    </div>
  );
}
