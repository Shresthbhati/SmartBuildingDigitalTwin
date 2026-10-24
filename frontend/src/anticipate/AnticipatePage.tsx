import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { SOURCE_STYLE, VISUAL_STATE_STYLE } from '../building/state';
import { errorMessage, nexusApi } from '../api/client';
import { SeriesChart } from '../charts/SeriesChart';
import { formatDateTime, formatValue } from '../lib/format';
import { useEnsureReplay, useSensorSeries } from '../lib/useSeries';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PredictedBadge,
  SourceBadge,
} from '../state/StateViews';
import { useNexus } from '../store';
import type { EnergyResponse, ForecastResponse, MaintenanceResponse } from '../types/nexus';

export function AnticipatePage() {
  return (
    <div className="page anticipate">
      <h1>Anticipate</h1>
      <div className="cards">
        <MaintenancePanel />
        <ForecastPanel />
      </div>
      <EnergyPanel />
    </div>
  );
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[], refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const depsKey = JSON.stringify(deps);
  const run = useCallback(async () => {
    void depsKey; // a changed dependency list makes this a new callback, which reloads
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [depsKey]);
  useEffect(() => {
    void run();
    if (!refreshMs) return;
    const id = window.setInterval(() => void run(), refreshMs);
    return () => window.clearInterval(id);
  }, [run, refreshMs]);
  return { data, error, loading, reload: run };
}

const RULE_LABEL: Record<string, string> = {
  anomaly_frequency: 'Frequent anomalies',
  alert_recurrence: 'Recurring alert',
  time_in_warning: 'Time above warning',
  sensor_flapping: 'Sensor dropping out',
  stale_now: 'Not reporting',
};

function MaintenancePanel() {
  const { data, error, loading, reload } = useLoad<MaintenanceResponse>(
    nexusApi.maintenance,
    [],
    60_000
  );
  const select = useNexus(s => s.select);
  const navigate = useNavigate();
  return (
    <section className="card" aria-label="Maintenance flags">
      <h2>
        Maintenance flags <PredictedBadge label="Rule-based (v1)" />
      </h2>
      {loading && <LoadingState />}
      {error && !data && <ErrorState message={error} onRetry={() => void reload()} />}
      {data && (
        <>
          <p className="dim">{data.disclaimer}</p>
          {data.flags.length === 0 && (
            <EmptyState
              title="Nothing needs attention"
              hint={`No rule fired in the last ${data.lookback_days} days.`}
            />
          )}
          <ul className="flag-list">
            {data.flags.map((f, i) => (
              <li key={i} className={`flag ${f.severity}`}>
                <div className="row between">
                  <strong>
                    <span aria-hidden="true">{f.severity === 'attention' ? '▲' : '◔'}</span>{' '}
                    {RULE_LABEL[f.rule] ?? f.rule}
                  </strong>
                  <span className="badge">
                    {f.severity === 'attention' ? 'Needs attention' : 'Watch'}
                  </span>
                </div>
                <div>{f.summary}</div>
                <div className="dim mono">
                  {f.sensor_id}
                  {f.location ? ` · ${f.location}` : ''}
                </div>
                <details>
                  <summary>Evidence</summary>
                  <pre className="evidence">{JSON.stringify(f.evidence, null, 2)}</pre>
                  <div className="row wrap">
                    {f.evidence_links.map(l => (
                      <button
                        key={`${l.kind}${l.id}`}
                        type="button"
                        className="btn small"
                        onClick={() => {
                          select(
                            l.kind === 'anomaly'
                              ? { anomalyId: l.id, alertId: null }
                              : { alertId: l.id, anomalyId: null }
                          );
                          navigate('/investigate');
                        }}
                      >
                        {l.kind === 'anomaly' ? 'σ' : '▲'} {l.kind} #{l.id}
                      </button>
                    ))}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ForecastPanel() {
  useEnsureReplay();
  const sensors = useNexus(
    useShallow(s => Object.values(s.sensors).filter(x => x.type === 'temperature'))
  );
  const [sensorId, setSensorId] = useState('');
  const [horizon, setHorizon] = useState(30);
  const sid = sensorId || sensors[0]?.sensor_id || '';
  const { data, error, loading } = useLoad<ForecastResponse | null>(
    () => (sid ? nexusApi.forecast(sid, horizon) : Promise.resolve(null)),
    [sid, horizon],
    30_000
  );
  const history = useSensorSeries(sid || null);
  const recent = useMemo(() => history.points.slice(-60), [history.points]);

  return (
    <section className="card" aria-label="Short-term forecast">
      <h2>
        Short-term forecast <PredictedBadge />
      </h2>
      <div className="row wrap">
        <label>
          Sensor
          <select value={sid} onChange={e => setSensorId(e.target.value)}>
            {sensors.map(s => (
              <option key={s.sensor_id} value={s.sensor_id}>
                {s.sensor_id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Horizon
          <select value={horizon} onChange={e => setHorizon(Number(e.target.value))}>
            {[15, 30, 60, 120].map(h => (
              <option key={h} value={h}>
                {h} min
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading && !data && <LoadingState />}
      {error && <ErrorState message={error} />}
      {data && (
        <>
          {data.abstained ? (
            <div className="state-banner partial" role="status">
              <strong>No forecast.</strong>{' '}
              {data.reason === 'stale'
                ? 'The latest reading is too old to extrapolate from.'
                : 'Not enough recent readings to fit a trend.'}{' '}
              <span className="dim">{data.detail}</span>
            </div>
          ) : (
            <>
              <SeriesChart
                series={[
                  {
                    id: 'h',
                    label: 'Recorded',
                    color: SOURCE_STYLE.simulated.color,
                    points: recent,
                  },
                  {
                    id: 'f',
                    label: 'Estimated trend',
                    color: '#e2e8f0',
                    dashed: true,
                    points: data.points.map(p => ({ t: Date.parse(p.t), v: p.v })),
                  },
                ]}
                bands={[
                  {
                    label: '95% range of the estimate',
                    color: '#e2e8f0',
                    points: data.points.map(p => ({ t: Date.parse(p.t), lo: p.lo, hi: p.hi })),
                  },
                ]}
                unit="°C"
                gapMs={history.gapMs}
                ariaLabel={`Recorded readings and estimated trend for ${sid}`}
              />
              <p className="dim">
                {data.method}. Fitted to {data.based_on?.n} readings; trend{' '}
                {data.slope_per_hour! >= 0 ? '+' : ''}
                {data.slope_per_hour} per hour, residual spread {data.residual_std}. An estimate
                from recent behaviour only: it knows nothing about weather, occupancy or equipment
                changes.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

function EnergyPanel() {
  const { data, error, loading, reload } = useLoad<EnergyResponse>(
    () => nexusApi.energy(),
    [],
    60_000
  );
  const colors = [VISUAL_STATE_STYLE.normal.color, '#a78bfa', '#fbbf24'];
  return (
    <section className="card wide" aria-label="Energy">
      <h2>
        Energy <SourceBadge source="simulated" />
      </h2>
      {loading && <LoadingState />}
      {error && !data && <ErrorState message={error} onRetry={() => void reload()} />}
      {data && (
        <>
          <p className="dim">
            {data.note} The meters are simulated, so these numbers describe the simulation, not a
            real building.
          </p>
          <SeriesChart
            series={data.meters.map((m, i) => ({
              id: m.sensor_id,
              label: `${m.location} (kW)`,
              color: colors[i % colors.length],
              points: m.series.map(p => ({ t: Date.parse(p.t), v: p.kw })),
            }))}
            domain={[Date.parse(data.start), Date.parse(data.end)]}
            unit="kW"
            gapMs={data.bucket_seconds * 3000}
            ariaLabel="Power draw per meter over the last 24 hours"
          />
          <table className="data-table" aria-label="Energy per meter">
            <thead>
              <tr>
                <th scope="col">Meter</th>
                <th scope="col">Energy (kWh)</th>
                <th scope="col">Average power</th>
                <th scope="col">Peak demand</th>
                <th scope="col">Data coverage</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {data.meters.map(m => (
                <tr key={m.sensor_id}>
                  <th scope="row">{m.location}</th>
                  <td className="mono">{m.kwh.toFixed(1)} kWh</td>
                  <td className="mono">{formatValue(m.avg_kw, 'kW', 1)}</td>
                  <td className="mono">
                    {formatValue(m.peak_kw, 'kW', 1)}
                    {m.peak_at && (
                      <span className="dim"> at {formatDateTime(Date.parse(m.peak_at))}</span>
                    )}
                  </td>
                  <td className="mono">
                    {Math.round(m.coverage * 100)}%
                    {m.coverage < 0.9 && <span className="dim"> (gaps)</span>}
                  </td>
                  <td>
                    <SourceBadge source={m.source === 'measured' ? 'measured' : 'simulated'} />
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <th scope="row">Total</th>
                <td className="mono">{data.total_kwh.toFixed(1)} kWh</td>
                <td />
                <td className="mono">
                  {formatValue(data.peak_kw_total, 'kW', 1)}{' '}
                  <span className="dim">(highest single meter)</span>
                </td>
                <td />
                <td />
              </tr>
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
