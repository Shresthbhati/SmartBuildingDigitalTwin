import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { errorMessage, nexusApi } from '../api/client';
import { BuildingScene } from '../building/BuildingScene';
import type { SnapshotFn } from '../building/sceneTypes';
import {
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_THRESHOLDS,
  SOURCE_STYLE,
  sensorVisualState,
} from '../building/state';
import { SeriesChart } from '../charts/SeriesChart';
import { formatClock, formatValue } from '../lib/format';
import { useCan } from '../lib/useAuth';
import { LoadingState } from '../state/StateViews';
import { useNexus } from '../store';
import { snapshotFor } from '../store/selectors';
import type { Meta, ScenarioResponse, ScenarioResult } from '../types/nexus';

const NO_FLOORS: never[] = [];
const BANNER = 'Simulation — not a control action';

/** Build a scene snapshot function that plays one side of a scenario run at a step index. */
export function scenarioSnapshotFn(
  results: ScenarioResult[],
  side: 'baseline' | 'scenario',
  index: number,
  meta: Meta | null
): SnapshotFn {
  const by = new Map(results.map(r => [r.sensor_id, r]));
  const th = meta?.thresholds ?? DEFAULT_THRESHOLDS;
  const staleMs = meta ? meta.stale_after_seconds * 1000 : DEFAULT_STALE_AFTER_MS;
  return (state, sensorId, nowMs) => {
    const base = snapshotFor(state, sensorId, nowMs);
    const r = by.get(sensorId);
    if (!r) {
      // Not part of this run: show it as "no data" rather than borrowing a live value.
      return {
        ...base,
        value: null,
        lastValue: null,
        timestampMs: null,
        source: null,
        mode: 'replay',
        aggregated: false,
        gap: true,
        visual: 'offline',
      };
    }
    const series = r[side];
    const p = series[Math.min(index, series.length - 1)];
    const ts = Date.parse(p.t);
    return {
      ...base,
      value: p.v,
      lastValue: p.v,
      timestampMs: ts,
      source: side === 'scenario' ? 'scenario' : 'simulated',
      mode: 'replay',
      aggregated: false,
      gap: false,
      visual: sensorVisualState({
        value: p.v,
        type: r.type,
        timestampMs: ts,
        nowMs: ts,
        staleAfterMs: staleMs,
        thresholds: th,
      }),
    };
  };
}

interface FormState {
  target: 'sensor' | 'floor';
  sensorId: string;
  floor: number;
  baselineOffset: number;
  variationScale: number;
  powerSetpoint: number | '';
  windowMinutes: number;
  label: string;
  save: boolean;
}

export function ExperimentPage() {
  const meta = useNexus(s => s.meta);
  const sensors = useNexus(
    useShallow(s => Object.values(s.sensors).filter(x => x.source === 'simulated'))
  );
  const floors = useNexus(s => s.topology?.floors ?? NO_FLOORS);
  const { allowed, promptLogin } = useCan('operator');
  const [form, setForm] = useState<FormState>({
    target: 'sensor',
    sensorId: '',
    floor: 0,
    baselineOffset: 3,
    variationScale: 1,
    powerSetpoint: '',
    windowMinutes: 120,
    label: '',
    save: false,
  });
  const [result, setResult] = useState<ScenarioResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [focusSensor, setFocusSensor] = useState<string>('');
  const [saved, setSaved] = useState<{ id: number; label: string | null; sensor_id: string }[]>([]);

  const sensorId = form.sensorId || sensors[0]?.sensor_id || '';
  const bounds = meta?.scenario_bounds;

  useEffect(() => {
    void nexusApi
      .listScenarios()
      .then(setSaved)
      .catch(() => setSaved([]));
  }, [result?.saved_run_id]);

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!bounds) return e;
    const [oLo, oHi] = bounds.baseline_offset;
    const [vLo, vHi] = bounds.variation_scale;
    const [pLo, pHi] = bounds.power_setpoint_kw;
    if (!(form.baselineOffset >= oLo && form.baselineOffset <= oHi))
      e.baselineOffset = `Between ${oLo} and ${oHi}`;
    if (!(form.variationScale >= vLo && form.variationScale <= vHi))
      e.variationScale = `Between ${vLo} and ${vHi}`;
    if (form.powerSetpoint !== '' && !(form.powerSetpoint >= pLo && form.powerSetpoint <= pHi))
      e.powerSetpoint = `Between ${pLo} and ${pHi} kW`;
    if (!(form.windowMinutes >= 1 && form.windowMinutes <= bounds.max_window_minutes))
      e.windowMinutes = `Between 1 and ${bounds.max_window_minutes}`;
    return e;
  }, [form, bounds]);

  async function run(save: boolean) {
    if (!allowed) return promptLogin();
    if (Object.keys(errors).length) return;
    setRunning(true);
    setRunError(null);
    try {
      const res = await nexusApi.runScenario({
        sensor_id: form.target === 'sensor' ? sensorId : null,
        floor: form.target === 'floor' ? form.floor : null,
        baseline_offset: form.baselineOffset,
        variation_scale: form.variationScale,
        power_setpoint_kw: form.powerSetpoint === '' ? null : form.powerSetpoint,
        window_minutes: form.windowMinutes,
        label: form.label || null,
        save,
      });
      setResult(res);
      setStep(0);
      setFocusSensor(res.results[0]?.sensor_id ?? '');
    } catch (e) {
      setRunError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  const results = useMemo(() => result?.results ?? [], [result]);
  const focus = results.find(r => r.sensor_id === focusSensor) ?? results[0];
  const steps = focus?.baseline.length ?? 0;
  const baselineFn = useMemo(
    () => scenarioSnapshotFn(results, 'baseline', step, meta),
    [results, step, meta]
  );
  const scenarioFn = useMemo(
    () => scenarioSnapshotFn(results, 'scenario', step, meta),
    [results, step, meta]
  );
  const num = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value === '' ? '' : Number(e.target.value) });

  return (
    <div className="page experiment">
      <div className="sim-banner" role="status">
        <span aria-hidden="true">⚗</span> {BANNER}
      </div>
      <div className="experiment-grid">
        <form
          className="card form-stack"
          aria-label="Scenario parameters"
          onSubmit={e => {
            e.preventDefault();
            void run(form.save);
          }}
        >
          <h2>Scenario</h2>
          <p className="dim">
            Re-runs the seeded sensor model twice, as configured and with your changes, entirely in
            memory. Live data is never touched.
          </p>
          <fieldset>
            <legend>Apply to</legend>
            <label className="check">
              <input
                type="radio"
                checked={form.target === 'sensor'}
                onChange={() => setForm({ ...form, target: 'sensor' })}
              />{' '}
              One sensor
            </label>
            <label className="check">
              <input
                type="radio"
                checked={form.target === 'floor'}
                onChange={() => setForm({ ...form, target: 'floor' })}
              />{' '}
              A whole floor
            </label>
          </fieldset>
          {form.target === 'sensor' ? (
            <label>
              Sensor
              <select
                value={sensorId}
                onChange={e => setForm({ ...form, sensorId: e.target.value })}
              >
                {sensors.map(s => (
                  <option key={s.sensor_id} value={s.sensor_id}>
                    {s.sensor_id} · {s.location}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Floor
              <select
                value={form.floor}
                onChange={e => setForm({ ...form, floor: Number(e.target.value) })}
              >
                {floors.map(f => (
                  <option key={f.level} value={f.level}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Field
            label="Baseline offset (°C)"
            hint="Temperature sensors"
            error={errors.baselineOffset}
          >
            <input
              type="number"
              step="0.5"
              value={form.baselineOffset}
              onChange={num('baselineOffset')}
              aria-invalid={!!errors.baselineOffset}
            />
          </Field>
          <Field
            label="Variation scale (×)"
            hint="Multiplies the sensor’s noise"
            error={errors.variationScale}
          >
            <input
              type="number"
              step="0.1"
              value={form.variationScale}
              onChange={num('variationScale')}
              aria-invalid={!!errors.variationScale}
            />
          </Field>
          <Field
            label="Power setpoint (kW)"
            hint="Power meters only; blank = unchanged"
            error={errors.powerSetpoint}
          >
            <input
              type="number"
              step="1"
              value={form.powerSetpoint}
              onChange={num('powerSetpoint')}
              aria-invalid={!!errors.powerSetpoint}
            />
          </Field>
          <Field label="Window (minutes)" error={errors.windowMinutes}>
            <input
              type="number"
              step="10"
              value={form.windowMinutes}
              onChange={num('windowMinutes')}
              aria-invalid={!!errors.windowMinutes}
            />
          </Field>
          <label>
            Label (optional)
            <input
              value={form.label}
              maxLength={200}
              onChange={e => setForm({ ...form, label: e.target.value })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.save}
              onChange={e => setForm({ ...form, save: e.target.checked })}
            />{' '}
            Save this run
          </label>
          {runError && (
            <div className="state-banner error" role="alert">
              {runError}
            </div>
          )}
          <button
            type="submit"
            className="btn primary"
            disabled={running || Object.keys(errors).length > 0}
          >
            {running ? 'Running…' : allowed ? 'Run scenario' : 'Sign in to run'}
          </button>
          {saved.length > 0 && (
            <details>
              <summary>Saved runs ({saved.length})</summary>
              <ul className="item-list">
                {saved.map(r => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="item"
                      onClick={() =>
                        void nexusApi.getScenario(r.id).then(res => {
                          setResult(res);
                          setStep(0);
                          setFocusSensor(res.results[0]?.sensor_id ?? '');
                        })
                      }
                    >
                      #{r.id} {r.label ?? r.sensor_id}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </form>

        <div className="experiment-results">
          {running && <LoadingState label="Running scenario" />}
          {!result && !running && (
            <p className="dim">
              Choose parameters and run to compare the building as configured against your scenario.
            </p>
          )}
          {result && focus && (
            <>
              <div className="split-scenes">
                <BuildingScene
                  compact
                  interactive={false}
                  syncGroup="scenario-cams"
                  snapshotFn={baselineFn}
                  caption="Baseline · as configured"
                />
                <BuildingScene
                  compact
                  interactive={false}
                  syncGroup="scenario-cams"
                  snapshotFn={scenarioFn}
                  caption="Scenario · your parameters"
                />
              </div>
              <div className="playhead">
                <label>
                  Playhead
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, steps - 1)}
                    value={step}
                    onChange={e => setStep(Number(e.target.value))}
                    aria-valuetext={formatClock(
                      Date.parse(focus.baseline[Math.min(step, steps - 1)].t),
                      false
                    )}
                  />
                </label>
                <span className="mono">
                  {formatClock(Date.parse(focus.baseline[Math.min(step, steps - 1)].t), false)}
                </span>
                <span className="dim">Both views and both charts follow this time.</span>
              </div>

              {results.length > 1 && (
                <label>
                  Chart sensor
                  <select value={focus.sensor_id} onChange={e => setFocusSensor(e.target.value)}>
                    {results.map(r => (
                      <option key={r.sensor_id} value={r.sensor_id}>
                        {r.sensor_id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <SeriesChart
                series={[
                  {
                    id: 'b',
                    label: 'Baseline',
                    color: SOURCE_STYLE.simulated.color,
                    points: focus.baseline.map(p => ({ t: Date.parse(p.t), v: p.v })),
                  },
                  {
                    id: 's',
                    label: 'Scenario',
                    color: '#fbbf24',
                    points: focus.scenario.map(p => ({ t: Date.parse(p.t), v: p.v })),
                  },
                ]}
                cursorMs={Date.parse(focus.baseline[Math.min(step, steps - 1)].t)}
                unit={focus.unit === 'celsius' ? '°C' : focus.unit}
                ariaLabel={`Baseline versus scenario for ${focus.sensor_id}`}
                onScrub={ms =>
                  setStep(
                    Math.max(
                      0,
                      focus.baseline.findIndex(p => Date.parse(p.t) >= ms)
                    )
                  )
                }
              />

              <table className="data-table" aria-label="Scenario results">
                <thead>
                  <tr>
                    <th scope="col">Sensor</th>
                    <th scope="col">Baseline mean</th>
                    <th scope="col">Scenario mean</th>
                    <th scope="col">Δ mean</th>
                    <th scope="col">Δ min / max</th>
                    <th scope="col">Clamped steps</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(r => (
                    <tr key={r.sensor_id}>
                      <th scope="row">{r.sensor_id}</th>
                      <td className="mono">{formatValue(r.delta.baseline_mean, r.unit, 2)}</td>
                      <td className="mono">{formatValue(r.delta.scenario_mean, r.unit, 2)}</td>
                      <td className="mono">
                        {r.delta.mean >= 0 ? '+' : ''}
                        {r.delta.mean.toFixed(2)}
                      </td>
                      <td className="mono">
                        {r.delta.min.toFixed(2)} / {r.delta.max.toFixed(2)}
                      </td>
                      <td className="mono">
                        {r.clamped_steps.scenario}
                        <span className="dim"> (baseline {r.clamped_steps.baseline})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <details open>
                <summary>Assumptions</summary>
                <ul className="assumptions">
                  <li>Model: {result.assumptions.model}</li>
                  <li>
                    Seed {result.assumptions.seed}; {result.assumptions.rng}
                  </li>
                  <li>
                    {result.assumptions.steps} steps of {result.assumptions.step_seconds}s from{' '}
                    {result.assumptions.start} ({result.assumptions.timezone})
                  </li>
                  <li>
                    Parameters: offset {result.assumptions.parameters.baseline_offset}, variation ×
                    {result.assumptions.parameters.variation_scale}, setpoint{' '}
                    {result.assumptions.parameters.power_setpoint_kw ?? 'unchanged'}
                  </li>
                  {result.assumptions.notes.map(n => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </details>
              {result.saved_run_id && <p className="dim">Saved as run #{result.saved_run_id}.</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={error ? 'invalid' : ''}>
      {label} {hint && <span className="dim">· {hint}</span>}
      {children}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
