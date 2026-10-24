import { useEffect, useMemo } from 'react';
import type { ChartPoint } from '../charts/SeriesChart';
import { useNexus } from '../store';

/** Make sure a replay window is loaded (it is the source of chart history), and keep it fresh. */
export function useEnsureReplay(refreshMs = 30_000): void {
  const status = useNexus(s => s.replay.status);
  useEffect(() => {
    if (status === 'idle') void useNexus.getState().loadReplay();
  }, [status]);
  useEffect(() => {
    const id = window.setInterval(() => {
      const st = useNexus.getState();
      if (st.cursor === 'live' && st.replay.status !== 'loading') void st.loadReplay();
    }, refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs]);
}

export interface SensorSeries {
  points: ChartPoint[];
  /** Break the line where readings are further apart than this: a gap is shown as a gap. */
  gapMs: number;
  aggregated: boolean;
}

/** History for one sensor from the replay window, with the freshest live reading appended. */
export function useSensorSeries(sensorId: string | null): SensorSeries {
  const data = useNexus(s => s.replay.data);
  const latest = useNexus(s => (sensorId ? s.latest[sensorId] : undefined));
  const cursor = useNexus(s => s.cursor);
  const staleSeconds = useNexus(s => s.meta?.stale_after_seconds ?? 120);

  return useMemo(() => {
    const sensor = data?.sensors.find(s => s.sensor_id === sensorId);
    const points: ChartPoint[] = (sensor?.points ?? []).map(p => ({ t: Date.parse(p.t), v: p.v }));
    // Live view only: extend with the newest streamed reading. Never in time travel.
    if (cursor === 'live' && latest) {
      const t = Date.parse(latest.event_timestamp);
      if (!points.length || t > points[points.length - 1].t) points.push({ t, v: latest.value });
    }
    const aggregated = sensor?.resolution === 'aggregated';
    const gapMs = Math.max(
      staleSeconds * 1000,
      aggregated && data ? data.bucket_seconds * 2000 : 0
    );
    return { points, gapMs, aggregated };
  }, [data, latest, cursor, sensorId, staleSeconds]);
}
