import type { LifecycleStatus, ReplayEntity, ReplayPoint } from '../types/nexus';

/**
 * Building Time Travel: reconstructing "what did the building look like at T".
 *
 * Rule (docs/VISION.md): the state of a sensor at T is its last reading at or before T,
 * provided that reading is no older than `stale_after`. Otherwise it is a gap. A gap is
 * never filled from the current snapshot and never treated as zero.
 */
export type SensorStateAt =
  | { kind: 'value'; point: ReplayPoint; atMs: number; ageSeconds: number }
  | { kind: 'gap'; lastPoint: ReplayPoint | null; ageSeconds: number | null }
  | { kind: 'no-data' };

/** Index of the last point with t <= tMs, or -1. `points` must be ascending by time. */
export function lastIndexAtOrBefore(points: { t: string }[], tMs: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Date.parse(points[mid].t) <= tMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function stateAt(
  points: ReplayPoint[],
  tMs: number,
  staleAfterSeconds: number
): SensorStateAt {
  const i = lastIndexAtOrBefore(points, tMs);
  if (i < 0) return { kind: 'no-data' };
  const point = points[i];
  const atMs = Date.parse(point.t);
  const ageSeconds = (tMs - atMs) / 1000;
  if (ageSeconds > staleAfterSeconds) return { kind: 'gap', lastPoint: point, ageSeconds };
  return { kind: 'value', point, atMs, ageSeconds };
}

/** Lifecycle status of an alert/anomaly as it was at T, or null if it did not exist yet. */
export function statusAt(entity: ReplayEntity, tMs: number): LifecycleStatus | null {
  const started = entity.started_at ? Date.parse(entity.started_at) : NaN;
  if (Number.isNaN(started) || started > tMs) return null;
  if (entity.resolved_at && Date.parse(entity.resolved_at) <= tMs) return 'RESOLVED';
  if (entity.acknowledged_at && Date.parse(entity.acknowledged_at) <= tMs) return 'ACKNOWLEDGED';
  return 'OPEN';
}

/** Entities that were open or acknowledged (not yet resolved) at T. */
export function activeAt(entities: ReplayEntity[], tMs: number): ReplayEntity[] {
  return entities.filter(e => {
    const s = statusAt(e, tMs);
    return s === 'OPEN' || s === 'ACKNOWLEDGED';
  });
}
