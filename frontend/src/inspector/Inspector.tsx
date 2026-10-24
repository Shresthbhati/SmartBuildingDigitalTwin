import { SeriesChart } from '../charts/SeriesChart';
import { IntelligencePanel } from '../investigate/IntelligencePanel';
import { SOURCE_STYLE, VISUAL_STATE_STYLE, worstState } from '../building/state';
import { alertTypeLabel, formatDateTime, formatValue, relativeAge } from '../lib/format';
import { useEnsureReplay, useSensorSeries } from '../lib/useSeries';
import { useNow } from '../lib/useNow';
import { EmptyState, SourceBadge, StaleBadge, StatusBadge } from '../state/StateViews';
import { useNexus } from '../store';
import { activeEntities, roomSensorIds, snapshotFor, thresholds } from '../store/selectors';
import { LifecycleActions } from './LifecycleActions';

export function Inspector() {
  const sel = useNexus(s => s.selection);
  useEnsureReplay();
  if (sel.anomalyId !== null) return <IntelligencePanel id={sel.anomalyId} />;
  if (sel.alertId !== null) return <AlertPanel id={sel.alertId} />;
  if (sel.room) return <RoomPanel code={sel.room} />;
  if (sel.sensor) return <SensorPanel id={sel.sensor} />;
  return (
    <EmptyState
      title="Nothing selected"
      hint="Select a room or sensor in the building, or an item in the list."
    />
  );
}

function SensorRows({ ids }: { ids: string[] }) {
  const state = useNexus();
  const now = useNow(1000);
  const timeTravel = state.cursor !== 'live';
  const ref = timeTravel ? (state.cursor as number) : now;
  return (
    <ul className="sensor-rows">
      {ids.map(id => {
        const s = snapshotFor(state, id, now);
        return (
          <li key={id}>
            <div className="row between">
              <button
                type="button"
                className="link mono"
                onClick={() => state.select({ sensor: id })}
                title="Show this sensor"
              >
                {id}
              </button>
              <StatusBadge state={s.visual} />
            </div>
            <div className="row between">
              <span className="big-value mono">
                {s.gap ? 'No data' : formatValue(s.value, s.unit, s.type === 'power_kw' ? 2 : 1)}
                {s.aggregated && <span className="dim"> (avg)</span>}
              </span>
              <span className="dim">{s.source && <SourceBadge source={s.source} />}</span>
            </div>
            {s.gap && s.lastValue !== null && (
              <div className="dim">
                Gap in the data. Last known {formatValue(s.lastValue, s.unit)}{' '}
                {relativeAge(s.timestampMs, ref)}.
              </div>
            )}
            {!s.gap && s.visual === 'stale' && (
              <StaleBadge lastSeenMs={s.timestampMs} nowMs={ref} />
            )}
            {!s.gap && s.timestampMs !== null && s.visual !== 'stale' && (
              <div className="dim">
                {timeTravel ? 'Reading at' : 'Updated'} {formatDateTime(s.timestampMs)} ·{' '}
                {relativeAge(s.timestampMs, ref)}
              </div>
            )}
            {s.timestampMs === null && <div className="dim">This sensor has never reported.</div>}
          </li>
        );
      })}
    </ul>
  );
}

function HistoryChart({ sensorId }: { sensorId: string }) {
  const series = useSensorSeries(sensorId);
  const state = useNexus();
  const snap = snapshotFor(state, sensorId);
  const th = thresholds(state);
  const status = useNexus(s => s.replay.status);
  const cursor = useNexus(s => s.cursor);
  const startMs = useNexus(s => s.replay.startMs);
  const endMs = useNexus(s => s.replay.endMs);
  const domain: [number, number] | undefined = endMs > startMs ? [startMs, endMs] : undefined;
  if (status === 'loading' && series.points.length === 0)
    return <p className="dim">Loading history…</p>;
  const color = snap.source ? SOURCE_STYLE[snap.source].color : VISUAL_STATE_STYLE.normal.color;
  return (
    <>
      <h3>History</h3>
      <SeriesChart
        series={[{ id: sensorId, label: sensorId, color, points: series.points }]}
        guides={
          snap.type === 'temperature'
            ? [
                { v: th.warning, label: 'warning', color: VISUAL_STATE_STYLE.warning.color },
                { v: th.critical, label: 'critical', color: VISUAL_STATE_STYLE.critical.color },
              ]
            : []
        }
        cursorMs={cursor === 'live' ? null : cursor}
        domain={domain}
        gapMs={series.gapMs}
        unit={snap.unit === 'celsius' ? '°C' : snap.unit}
        ariaLabel={`History of ${sensorId}`}
        onScrub={ms => void useNexus.getState().setCursor(ms)}
      />
      {series.aggregated && (
        <p className="dim">Aggregated over this window; each point is a bucket average.</p>
      )}
    </>
  );
}

function RoomPanel({ code }: { code: string }) {
  const state = useNexus();
  const now = useNow(1000);
  const room = state.topology?.floors.flatMap(f => f.rooms).find(r => r.code === code);
  const floor = state.topology?.floors.find(f => f.rooms.some(r => r.code === code));
  if (!room || !floor) return <EmptyState title={`Unknown room ${code}`} />;
  const ids = roomSensorIds(state, code);
  const visual = worstState(ids.map(id => snapshotFor(state, id, now).visual));
  const active = activeEntities(state);
  const anomalyIds = active.anomaliesByRoom.get(code) ?? [];
  const alerts = Object.values(state.alerts).filter(
    a => a.room === code && a.status !== 'RESOLVED'
  );
  const primary = ids.find(id => state.sensors[id]?.type === 'temperature') ?? ids[0];
  return (
    <div className="panel-stack">
      <header>
        <h2>{room.name}</h2>
        <div className="dim">
          {floor.name} · {code}
        </div>
        <StatusBadge state={visual} />
      </header>
      <SensorRows ids={ids} />
      {primary && <HistoryChart sensorId={primary} />}
      <h3>Open items</h3>
      {anomalyIds.length === 0 && alerts.length === 0 && (
        <p className="dim">
          No open anomalies or alerts{state.cursor !== 'live' ? ' at this time' : ''}.
        </p>
      )}
      <ul className="item-list">
        {anomalyIds.map(id => (
          <li key={`a${id}`}>
            <button
              type="button"
              className="item anomaly"
              onClick={() => state.select({ anomalyId: id, alertId: null })}
            >
              <span aria-hidden="true">σ</span> Statistical anomaly #{id}
            </button>
          </li>
        ))}
        {alerts.map(a => (
          <li key={`t${a.id}`}>
            <button
              type="button"
              className="item alert"
              onClick={() => state.select({ alertId: a.id, anomalyId: null })}
            >
              <span aria-hidden="true">▲</span> {alertTypeLabel(a.alert_type)} ·{' '}
              {a.status.toLowerCase()}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" onClick={() => state.requestFocus({ room: code })}>
        Focus camera
      </button>
    </div>
  );
}

function SensorPanel({ id }: { id: string }) {
  const sensor = useNexus(s => s.sensors[id]);
  if (!sensor) return <EmptyState title={`Unknown sensor ${id}`} />;
  return (
    <div className="panel-stack">
      <header>
        <h2 className="mono">{id}</h2>
        <div className="dim">
          {sensor.type} · {sensor.location} · floor {sensor.floor}
        </div>
      </header>
      <SensorRows ids={[id]} />
      <HistoryChart sensorId={id} />
      <button
        type="button"
        className="btn"
        onClick={() => useNexus.getState().requestFocus({ sensor: id })}
      >
        Focus camera
      </button>
    </div>
  );
}

function AlertPanel({ id }: { id: number }) {
  const alert = useNexus(s => s.alerts[id]);
  const select = useNexus(s => s.select);
  if (!alert) return <EmptyState title={`Alert ${id} not found`} />;
  return (
    <div className="panel-stack">
      <header>
        <div className="kind-tag alert">
          <span aria-hidden="true">▲</span> Threshold alert · rule-based
        </div>
        <h2>{alert.title}</h2>
        <div className="row">
          <span className={`badge sev ${alert.severity.toLowerCase()}`}>{alert.severity}</span>
          <span className="badge">{alert.status}</span>
        </div>
      </header>
      <dl className="facts">
        <dt>Type</dt>
        <dd>{alertTypeLabel(alert.alert_type)}</dd>
        <dt>Where</dt>
        <dd>
          {alert.room} · {alert.sensor_id || 'room-level'}
        </dd>
        <dt>First seen</dt>
        <dd>{formatDateTime(Date.parse(alert.first_occurrence))}</dd>
        <dt>Last seen</dt>
        <dd>{formatDateTime(Date.parse(alert.last_occurrence))}</dd>
        <dt>Occurrences</dt>
        <dd>{alert.occurrence_count}</dd>
        {alert.last_reading_value !== null && (
          <>
            <dt>Last reading</dt>
            <dd>{alert.last_reading_value}</dd>
          </>
        )}
        {alert.acknowledged_at && (
          <>
            <dt>Acknowledged</dt>
            <dd>{formatDateTime(Date.parse(alert.acknowledged_at))}</dd>
          </>
        )}
        {alert.resolved_at && (
          <>
            <dt>Resolved</dt>
            <dd>{formatDateTime(Date.parse(alert.resolved_at))}</dd>
          </>
        )}
      </dl>
      <p className="dim">
        A threshold alert fires when a reading crosses a fixed limit. It is different from a
        statistical anomaly, which flags a reading that is unusual for that sensor.
      </p>
      <LifecycleActions kind="alert" id={id} status={alert.status} />
      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={() => select({ room: alert.room, alertId: null })}
        >
          Back to {alert.room}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void useNexus.getState().setCursor(Date.parse(alert.first_occurrence))}
        >
          Jump to start in timeline
        </button>
      </div>
    </div>
  );
}
