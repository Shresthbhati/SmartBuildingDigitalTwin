import type { ReactNode } from 'react';
import { SOURCE_STYLE, VISUAL_STATE_STYLE, type VisualState } from '../building/state';
import { relativeAge } from '../lib/format';
import { useNow } from '../lib/useNow';
import type { ReadingSourceName } from '../types/nexus';

// Shared presentation of the states every data view can be in. Text and an icon always
// accompany colour: status is never conveyed by colour alone.

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state-view loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="state-view empty" role="status">
      <span className="state-icon" aria-hidden="true">
        ○
      </span>
      <strong>{title}</strong>
      {hint && <span className="state-hint">{hint}</span>}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string;
  message?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="state-view error" role="alert">
      <span className="state-icon" aria-hidden="true">
        ✕
      </span>
      <strong>{title}</strong>
      {message && <span className="state-hint">{message}</span>}
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Some of the data loaded and some did not: say so rather than showing a quietly smaller truth. */
export function PartialNotice({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;
  return (
    <div className="state-banner partial" role="status">
      <span aria-hidden="true">◐</span> Partial data: couldn’t load {missing.join(', ')}.
    </div>
  );
}

export function StatusBadge({ state, compact = false }: { state: VisualState; compact?: boolean }) {
  const s = VISUAL_STATE_STYLE[state];
  return (
    <span
      className={`badge status ${state}`}
      style={{ color: s.color, borderColor: s.color }}
      title={s.description}
    >
      <span aria-hidden="true">{s.icon}</span>
      {!compact && <span>{s.label}</span>}
      {compact && <span className="sr-only">{s.label}</span>}
    </span>
  );
}

/** "Stale · last seen 3 min ago": a reading that is too old to be called current. */
export function StaleBadge({ lastSeenMs, nowMs }: { lastSeenMs: number | null; nowMs?: number }) {
  const tick = useNow();
  return (
    <span
      className="badge stale"
      style={{ color: VISUAL_STATE_STYLE.stale.color, borderColor: VISUAL_STATE_STYLE.stale.color }}
    >
      <span aria-hidden="true">{VISUAL_STATE_STYLE.stale.icon}</span>
      Stale · last seen {relativeAge(lastSeenMs, nowMs ?? tick)}
    </span>
  );
}

/** Provenance of a value. Violet always means "not a real measurement". */
export function SourceBadge({ source }: { source: ReadingSourceName }) {
  const s = SOURCE_STYLE[source];
  return (
    <span
      className={`badge source ${source}`}
      style={{ color: s.color, borderColor: s.color }}
      title={`Data source: ${s.label}`}
    >
      <span aria-hidden="true">◇</span>
      {s.label}
    </span>
  );
}

/** For forecasts and anything else that is a model output, not an observation. */
export function PredictedBadge({ label = 'Estimated' }: { label?: string }) {
  return (
    <span className="badge predicted" title="Model output, not an observation">
      <span aria-hidden="true">≈</span>
      {label}
    </span>
  );
}

/** Persistent "what am I looking at" strip: mode + where the data comes from. */
export function ModeSourceBadge({
  mode,
  source,
  detail,
}: {
  mode: string;
  source: 'live' | 'time-travel' | 'scenario' | 'estimated' | 'simulated';
  detail?: ReactNode;
}) {
  const labels: Record<typeof source, string> = {
    live: 'LIVE',
    'time-travel': 'TIME TRAVEL',
    scenario: 'SCENARIO · NOT LIVE',
    estimated: 'ESTIMATED',
    simulated: 'SIMULATED DATA',
  };
  return (
    <div className="mode-badge" role="status" aria-label={`${mode} mode, ${labels[source]}`}>
      <span className="mode-name">{mode}</span>
      <span className={`source-pill ${source}`}>{labels[source]}</span>
      {detail && <span className="mode-detail">{detail}</span>}
    </div>
  );
}
