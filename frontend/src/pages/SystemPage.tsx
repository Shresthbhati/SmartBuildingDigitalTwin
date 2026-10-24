import { useCallback, useEffect, useState } from 'react';
import { activityApi, errorMessage, healthApi, retentionApi, simulatorApi } from '../api/client';
import { formatDateTime, relativeAge } from '../lib/format';
import { useCan } from '../lib/useAuth';
import { useNow } from '../lib/useNow';
import { ErrorState, LoadingState } from '../state/StateViews';
import { useNexus } from '../store';
import type {
  ActivityLog,
  DetailedHealthResponse,
  RetentionStatus,
  SimulatorStatus,
} from '../types';
import type { InjectRequest } from '../types/nexus';

export function SystemPage() {
  const [health, setHealth] = useState<DetailedHealthResponse | null>(null);
  const [sim, setSim] = useState<SimulatorStatus | null>(null);
  const [retention, setRetention] = useState<RetentionStatus | null>(null);
  const [activity, setActivity] = useState<ActivityLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const connection = useNexus(s => s.connection);
  const now = useNow(1000);

  const refresh = useCallback(async () => {
    try {
      const [h, s, r, a] = await Promise.all([
        healthApi.detailed(),
        simulatorApi.getStatus(),
        retentionApi.getStatus(),
        activityApi.getLogs(15),
      ]);
      setHealth(h);
      setSim(s);
      setRetention(r);
      setActivity(a);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const id = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (error && !health)
    return (
      <ErrorState
        title="Couldn’t reach the backend"
        message={error}
        onRetry={() => void refresh()}
      />
    );
  if (!health) return <LoadingState label="Loading system status" />;

  const recent = health.recent_errors as unknown as {
    ts: string;
    level: string;
    logger: string;
    message: string;
  }[];

  return (
    <div className="page system">
      <h1>System</h1>
      <div className="cards">
        <section className="card" aria-label="Health">
          <h2>Health</h2>
          <dl className="facts">
            <dt>Overall</dt>
            <dd>
              <span className={`badge ${health.status === 'healthy' ? 'ok' : 'warn'}`}>
                {health.status === 'healthy' ? '● Healthy' : '▲ Degraded'}
              </span>
            </dd>
            <dt>Database</dt>
            <dd>{health.database}</dd>
            <dt>MQTT</dt>
            <dd>{health.mqtt}</dd>
            <dt>Simulator</dt>
            <dd>{health.simulator}</dd>
            <dt>Last ingestion</dt>
            <dd>
              {health.last_ingestion
                ? relativeAge(Date.parse(health.last_ingestion), now)
                : 'never'}
            </dd>
            <dt>Live stream</dt>
            <dd>
              {connection.state}
              {connection.state === 'live'
                ? ` · ${(health as unknown as { websocket_clients: number }).websocket_clients} client(s)`
                : ''}
            </dd>
          </dl>
        </section>
        <Controls sim={sim} retention={retention} onChanged={refresh} />
      </div>

      <section className="card" aria-label="Recent errors">
        <h2>Recent warnings and errors</h2>
        {recent.length === 0 ? (
          <p className="dim">None since startup.</p>
        ) : (
          <ul className="log">
            {[...recent].reverse().map((e, i) => (
              <li key={i}>
                <span className="mono dim">{formatDateTime(Date.parse(e.ts))}</span>{' '}
                <span className={`badge ${e.level === 'ERROR' ? 'crit' : 'warn'}`}>{e.level}</span>{' '}
                {e.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-label="Recent activity">
        <h2>Room status changes</h2>
        {activity.length === 0 ? (
          <p className="dim">No changes yet.</p>
        ) : (
          <ul className="log">
            {[...activity].reverse().map(a => (
              <li key={a.id}>
                <span className="mono dim">{formatDateTime(Date.parse(a.timestamp))}</span>{' '}
                {a.message}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Controls({
  sim,
  retention,
  onChanged,
}: {
  sim: SimulatorStatus | null;
  retention: RetentionStatus | null;
  onChanged: () => void;
}) {
  const operator = useCan('operator');
  const admin = useCan('admin');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState<InjectRequest>({
    sensor_id: 'temp-sensor-204',
    kind: 'spike',
    duration_seconds: 30,
  });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) });
    }
  };
  const sensors = sim?.sensors ?? [];

  return (
    <>
      <section className="card" aria-label="Demo scenario injection">
        <h2>Inject a live demo scenario</h2>
        <p className="dim">
          Makes a simulated sensor misbehave. Its readings are tagged “scenario-injected”
          everywhere.
        </p>
        <form
          className="form-grid"
          onSubmit={e => {
            e.preventDefault();
            if (!operator.allowed) return operator.promptLogin();
            void run(
              () => simulatorApi.inject(form),
              `Injected ${form.kind} on ${form.sensor_id} for ${form.duration_seconds}s`
            );
          }}
        >
          <label>
            Sensor
            <select
              value={form.sensor_id}
              onChange={e => setForm({ ...form, sensor_id: e.target.value })}
            >
              {sensors.map(s => (
                <option key={s.sensor_id} value={s.sensor_id}>
                  {s.sensor_id} ({s.room})
                </option>
              ))}
            </select>
          </label>
          <label>
            Kind
            <select
              value={form.kind}
              onChange={e => setForm({ ...form, kind: e.target.value as InjectRequest['kind'] })}
            >
              <option value="spike">Spike</option>
              <option value="drift">Drift</option>
              <option value="offline">Go offline</option>
            </select>
          </label>
          <label>
            Duration (s)
            <input
              type="number"
              min={1}
              max={3600}
              value={form.duration_seconds}
              onChange={e => setForm({ ...form, duration_seconds: Number(e.target.value) })}
            />
          </label>
          <button type="submit" className="btn primary">
            {operator.allowed ? 'Inject' : 'Sign in to inject'}
          </button>
        </form>
        {sim?.injections && sim.injections.length > 0 && (
          <p className="dim">
            Active: {sim.injections.map(i => `${i.kind} on ${i.sensor_id}`).join(', ')}
          </p>
        )}
        {msg && (
          <div className={`state-banner ${msg.ok ? 'partial' : 'error'}`} role="status">
            {msg.text}
          </div>
        )}
      </section>

      <section className="card" aria-label="Operations">
        <h2>
          Operations <span className="dim">(admin)</span>
        </h2>
        <div className="row wrap">
          <button
            type="button"
            className="btn"
            onClick={() =>
              admin.allowed
                ? void run(simulatorApi.start, 'Simulator started')
                : admin.promptLogin()
            }
          >
            Start simulator
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              admin.allowed ? void run(simulatorApi.stop, 'Simulator stopped') : admin.promptLogin()
            }
          >
            Stop simulator
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              admin.allowed
                ? void run(retentionApi.runCleanup, 'Retention cleanup ran')
                : admin.promptLogin()
            }
          >
            Run retention now
          </button>
        </div>
        {retention && (
          <p className="dim">
            Retention keeps {retention.raw_telemetry_days} days of raw telemetry · last run{' '}
            {retention.last_run ? formatDateTime(Date.parse(retention.last_run)) : 'never'}.
          </p>
        )}
      </section>
    </>
  );
}
