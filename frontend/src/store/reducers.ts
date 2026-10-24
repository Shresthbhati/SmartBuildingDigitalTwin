import type { AlertListItem } from '../types';
import type {
  AnomalyListItem,
  LatestReading,
  LifecycleEventData,
  ReadingEventData,
  SensorInfo,
} from '../types/nexus';

// Pure state transitions for stream events. The zustand store wires these to `set`.

export interface ReadingSlice {
  latest: Record<string, LatestReading>;
  sensors: Record<string, SensorInfo>;
  pulses: Record<string, number>;
}

/**
 * A new reading replaces the sensor's latest value only if it is not older than the one we
 * already have (MQTT can deliver out of order), and fires exactly one pulse. Pulses are a
 * per-sensor counter: the scene animates when the counter changes, never on a timer.
 */
export function reduceReading(slice: ReadingSlice, d: ReadingEventData): ReadingSlice {
  const prev = slice.latest[d.sensor_id];
  if (prev && Date.parse(d.event_timestamp) < Date.parse(prev.event_timestamp)) {
    return slice; // late arrival: keep the newer value, no pulse
  }
  const sensor = slice.sensors[d.sensor_id];
  return {
    latest: {
      ...slice.latest,
      [d.sensor_id]: {
        sensor_id: d.sensor_id,
        room: d.room,
        measurement: d.measurement,
        value: d.value,
        unit: d.unit,
        source: d.source,
        event_timestamp: d.event_timestamp,
      },
    },
    sensors: sensor
      ? { ...slice.sensors, [d.sensor_id]: { ...sensor, last_seen_at: d.event_timestamp } }
      : slice.sensors,
    pulses: { ...slice.pulses, [d.sensor_id]: (slice.pulses[d.sensor_id] ?? 0) + 1 },
  };
}

export interface FlashSlice {
  alerts: Record<number, AlertListItem>;
  anomalies: Record<number, AnomalyListItem>;
  /** Set when a brand-new anomaly arrives so the scene can play its one-shot choreography. */
  anomalyFlash: { id: number; room: string; sensorId: string; nonce: number } | null;
}

/**
 * Lifecycle events carry the new status, not the whole record. Apply what we know right away
 * (so the scene reacts instantly); the store then refetches over REST, which is the truth.
 */
export function reduceLifecycle(
  slice: FlashSlice,
  type: 'alert' | 'anomaly',
  d: LifecycleEventData
): FlashSlice {
  if (type === 'alert') {
    const existing = slice.alerts[d.id];
    const next: AlertListItem = existing
      ? { ...existing, status: d.status }
      : {
          id: d.id,
          room: d.room,
          sensor_id: d.sensor_id,
          alert_type: (d.alert_type ?? 'high_temperature') as AlertListItem['alert_type'],
          severity: d.severity,
          title: d.title,
          status: d.status,
          first_occurrence: d.at,
          last_occurrence: d.at,
          acknowledged_at: null,
          resolved_at: null,
          last_reading_value: null,
          occurrence_count: 1,
        };
    if (d.event === 'acknowledged') next.acknowledged_at = d.at;
    if (d.event === 'resolved') next.resolved_at = d.at;
    return { ...slice, alerts: { ...slice.alerts, [d.id]: next } };
  }

  const existing = slice.anomalies[d.id];
  const next: AnomalyListItem = existing
    ? { ...existing, status: d.status }
    : {
        id: d.id,
        room: d.room,
        sensor_id: d.sensor_id,
        anomaly_category: d.anomaly_category ?? 'z_score_spike',
        severity: d.severity,
        title: d.title,
        status: d.status,
        detected_at: d.at,
        last_observed_at: d.at,
        acknowledged_at: null,
        resolved_at: null,
        observed_value: NaN, // unknown until the REST refetch fills it in
        expected_baseline: NaN,
        deviation_score: NaN,
        occurrence_count: 1,
      };
  if (d.event === 'acknowledged') next.acknowledged_at = d.at;
  if (d.event === 'resolved') next.resolved_at = d.at;
  const isNew = d.event === 'created' && !existing;
  return {
    ...slice,
    anomalies: { ...slice.anomalies, [d.id]: next },
    anomalyFlash: isNew
      ? {
          id: d.id,
          room: d.room,
          sensorId: d.sensor_id,
          nonce: (slice.anomalyFlash?.nonce ?? 0) + 1,
        }
      : slice.anomalyFlash,
  };
}

export function indexBy<T, K extends string | number>(
  items: T[],
  key: (item: T) => K
): Record<K, T> {
  const out = {} as Record<K, T>;
  for (const item of items) out[key(item)] = item;
  return out;
}
