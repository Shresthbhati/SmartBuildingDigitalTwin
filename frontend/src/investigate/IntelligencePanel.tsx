import { useEffect } from 'react';
import { SeriesChart } from '../charts/SeriesChart';
import { SOURCE_STYLE, VISUAL_STATE_STYLE } from '../building/state';
import { LifecycleActions } from '../inspector/LifecycleActions';
import { categoryLabel, formatDateTime, formatValue, relativeAge } from '../lib/format';
import { EmptyState, ErrorState, LoadingState, SourceBadge } from '../state/StateViews';
import { useNexus } from '../store';
import { CausalGraph } from './CausalGraph';

/** Why was this flagged? Observed value, the baseline it was judged against, and the evidence. */
export function IntelligencePanel({ id }: { id: number }) {
  const item = useNexus(s => s.anomalies[id]);
  const detail = useNexus(s => s.details[id]);
  const ctx = useNexus(s => s.contexts[id]);
  const meta = useNexus(s => s.meta);
  const loadDetail = useNexus(s => s.loadAnomalyDetail);
  const loadContext = useNexus(s => s.loadAnomalyContext);
  const select = useNexus(s => s.select);
  const requestFocus = useNexus(s => s.requestFocus);

  useEffect(() => {
    void loadDetail(id);
    void loadContext(id);
  }, [id, loadDetail, loadContext]);

  if (!item && !detail) return <EmptyState title={`Anomaly ${id} not found`} />;
  const a = detail ?? item!;
  const m = detail?.metadata ?? null;
  const baseline = ctx?.data?.evidence.baseline ?? null;
  const detectedMs = Date.parse(a.detected_at);
  const zThr = m?.detector_config?.z_score_threshold ?? meta?.anomaly_detection.z_score_threshold;
  const unit = m?.unit === 'celsius' ? '°C' : (m?.unit ?? '°C');
  const readings = (ctx?.data?.evidence.readings ?? []).map(r => ({ t: Date.parse(r.t), v: r.v }));

  return (
    <div className="panel-stack">
      <header>
        <div className="kind-tag anomaly">
          <span aria-hidden="true">σ</span> Statistical anomaly · baseline-based
        </div>
        <h2>{a.title}</h2>
        <div className="row">
          <span className={`badge sev ${a.severity.toLowerCase()}`}>{a.severity}</span>
          <span className="badge">{a.status}</span>
          {m?.source && <SourceBadge source={m.source} />}
        </div>
        <div className="dim">
          {categoryLabel(a.anomaly_category)} · {a.room} ·{' '}
          <span className="mono">{a.sensor_id}</span>
        </div>
      </header>

      <section aria-label="Why this was flagged">
        <h3>Why it was flagged</h3>
        <dl className="facts">
          <dt>Observed</dt>
          <dd className="mono">
            {Number.isFinite(a.observed_value) ? formatValue(a.observed_value, 'celsius') : '…'}
          </dd>
          <dt>Baseline</dt>
          <dd className="mono">
            {Number.isFinite(a.expected_baseline)
              ? formatValue(a.expected_baseline, 'celsius')
              : '…'}
            {m?.rolling_stddev !== undefined && <> ± {m.rolling_stddev.toFixed(2)} σ</>}
          </dd>
          <dt>Deviation (z-score)</dt>
          <dd className="mono">
            {Number.isFinite(a.deviation_score) ? a.deviation_score.toFixed(2) : '…'}
            {zThr !== undefined && <span className="dim"> (flagged above {zThr})</span>}
          </dd>
          <dt>Baseline window</dt>
          <dd>
            {m?.sample_count ?? '…'} of the last {m?.window_size ?? '…'} readings, excluding the
            flagged one
          </dd>
          <dt>Detected</dt>
          <dd>
            {formatDateTime(detectedMs)} · {relativeAge(detectedMs)}
          </dd>
          <dt>Occurrences</dt>
          <dd>{a.occurrence_count}</dd>
        </dl>
        {m?.detector_config && (
          <details>
            <summary>Detector configuration</summary>
            <dl className="facts">
              <dt>z-score threshold</dt>
              <dd>{m.detector_config.z_score_threshold}</dd>
              <dt>Spike / drop</dt>
              <dd>
                {m.detector_config.spike_threshold} / {m.detector_config.drop_threshold}
              </dd>
              <dt>Min. samples</dt>
              <dd>{m.detector_config.min_samples}</dd>
              <dt>Cooldown</dt>
              <dd>{m.detector_config.cooldown_seconds}s</dd>
            </dl>
          </details>
        )}
        <p className="dim">
          This reading was unusual for this sensor. That is not the same as a threshold breach.
        </p>
      </section>

      <LifecycleActions kind="anomaly" id={id} status={a.status} />
      <div className="row wrap">
        <button
          type="button"
          className="btn"
          onClick={() => requestFocus({ sensor: a.sensor_id, room: a.room })}
        >
          Focus camera
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void useNexus.getState().setCursor(detectedMs)}
        >
          Jump to detection in timeline
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => select({ anomalyId: null, room: a.room })}
        >
          Back to room
        </button>
      </div>

      <section aria-label="Evidence">
        <h3>Evidence</h3>
        {ctx?.status === 'loading' && !ctx.data && <LoadingState label="Loading evidence" />}
        {ctx?.status === 'error' && (
          <ErrorState
            title="Couldn’t load evidence"
            message={ctx.error}
            onRetry={() => void loadContext(id)}
          />
        )}
        {ctx?.data && (
          <SeriesChart
            series={[
              {
                id: a.sensor_id,
                label: `${a.sensor_id} readings`,
                color: SOURCE_STYLE.simulated.color,
                points: readings,
              },
            ]}
            flatBand={
              baseline
                ? {
                    lo: baseline.lower,
                    hi: baseline.upper,
                    color: VISUAL_STATE_STYLE.normal.color,
                    label: `Expected range (mean ± ${baseline.z_threshold}σ)`,
                  }
                : undefined
            }
            markers={[{ t: detectedMs, label: 'Detected', color: '#fbbf24' }]}
            domain={readings.length ? [readings[0].t, readings[readings.length - 1].t] : undefined}
            unit={unit}
            gapMs={(meta?.stale_after_seconds ?? 120) * 1000}
            ariaLabel={`Readings around the detection of anomaly ${id} with the detector's expected range`}
          />
        )}
      </section>

      <section aria-label="Investigation graph">
        <h3>What was happening nearby</h3>
        {ctx?.data && (
          <CausalGraph
            nodes={ctx.data.nodes}
            edges={ctx.data.edges}
            disclaimer={ctx.data.disclaimer}
          />
        )}
      </section>
    </div>
  );
}
