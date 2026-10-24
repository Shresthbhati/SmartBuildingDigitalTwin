import { describe, expect, it } from 'vitest';
import type { AlertListItem } from '../types';
import type {
  AnomalyListItem,
  LifecycleEventData,
  ReadingEventData,
  SensorInfo,
} from '../types/nexus';
import {
  indexBy,
  reduceLifecycle,
  reduceReading,
  type FlashSlice,
  type ReadingSlice,
} from './reducers';

const sensor: SensorInfo = {
  sensor_id: 'temp-sensor-101',
  type: 'temperature',
  unit: 'celsius',
  source: 'simulated',
  enabled: true,
  last_seen_at: null,
  location: 'room101',
  floor: 0,
};

const reading = (
  value: number,
  ts: string,
  source: ReadingEventData['source'] = 'simulated'
): ReadingEventData => ({
  sensor_id: 'temp-sensor-101',
  room: 'room101',
  measurement: 'temperature',
  value,
  unit: 'celsius',
  source,
  event_timestamp: ts,
  room_status: 'NORMAL',
});

const empty = (): ReadingSlice => ({
  latest: {},
  sensors: { [sensor.sensor_id]: sensor },
  pulses: {},
});

describe('reduceReading', () => {
  it('stores the latest value with its real event timestamp and source', () => {
    const s = reduceReading(empty(), reading(22.4, '2026-03-02T12:00:00Z', 'scenario'));
    expect(s.latest['temp-sensor-101']).toMatchObject({
      value: 22.4,
      source: 'scenario',
      event_timestamp: '2026-03-02T12:00:00Z',
    });
  });

  it("updates the sensor's last_seen_at from the reading, not from the wall clock", () => {
    const s = reduceReading(empty(), reading(22.4, '2026-03-02T12:00:00Z'));
    expect(s.sensors['temp-sensor-101'].last_seen_at).toBe('2026-03-02T12:00:00Z');
  });

  it('fires exactly one pulse per new reading', () => {
    let s = reduceReading(empty(), reading(22.4, '2026-03-02T12:00:00Z'));
    expect(s.pulses['temp-sensor-101']).toBe(1);
    s = reduceReading(s, reading(22.5, '2026-03-02T12:00:05Z'));
    expect(s.pulses['temp-sensor-101']).toBe(2);
  });

  it('ignores a late (out-of-order) reading: keeps the newer value and does not pulse', () => {
    const s1 = reduceReading(empty(), reading(30.0, '2026-03-02T12:00:10Z'));
    const s2 = reduceReading(s1, reading(20.0, '2026-03-02T12:00:05Z'));
    expect(s2).toBe(s1);
    expect(s2.latest['temp-sensor-101'].value).toBe(30.0);
    expect(s2.pulses['temp-sensor-101']).toBe(1);
  });

  it('does not mutate its input', () => {
    const before = empty();
    reduceReading(before, reading(22.4, '2026-03-02T12:00:00Z'));
    expect(before.latest).toEqual({});
    expect(before.pulses).toEqual({});
  });

  it('accepts readings for sensors missing from the topology without inventing one', () => {
    const s = reduceReading(
      { latest: {}, sensors: {}, pulses: {} },
      reading(22.4, '2026-03-02T12:00:00Z')
    );
    expect(s.latest['temp-sensor-101'].value).toBe(22.4);
    expect(s.sensors).toEqual({});
  });
});

const flash = (): FlashSlice => ({ alerts: {}, anomalies: {}, anomalyFlash: null });
const event = (over: Partial<LifecycleEventData>): LifecycleEventData => ({
  event: 'created',
  id: 7,
  room: 'room204',
  sensor_id: 'temp-sensor-204',
  severity: 'CRITICAL',
  status: 'OPEN',
  title: 'Critical statistical spike in room204',
  actor: 'system',
  at: '2026-03-02T12:00:00Z',
  anomaly_category: 'z_score_spike',
  ...over,
});

describe('reduceLifecycle: anomalies', () => {
  it('adds a new anomaly and raises a one-shot flash for the scene', () => {
    const s = reduceLifecycle(flash(), 'anomaly', event({}));
    expect(s.anomalies[7]).toMatchObject({
      room: 'room204',
      status: 'OPEN',
      anomaly_category: 'z_score_spike',
    });
    expect(s.anomalyFlash).toMatchObject({
      id: 7,
      room: 'room204',
      sensorId: 'temp-sensor-204',
      nonce: 1,
    });
  });

  it('does not invent the numbers it does not know yet', () => {
    const a = reduceLifecycle(flash(), 'anomaly', event({})).anomalies[7];
    expect(Number.isNaN(a.observed_value)).toBe(true); // filled in by the REST refetch
  });

  it('a second new anomaly gets a new flash nonce', () => {
    const s1 = reduceLifecycle(flash(), 'anomaly', event({}));
    const s2 = reduceLifecycle(s1, 'anomaly', event({ id: 8 }));
    expect(s2.anomalyFlash?.nonce).toBe(2);
  });

  it('acknowledge/resolve update status and timestamps without a flash', () => {
    const s1 = reduceLifecycle(flash(), 'anomaly', event({}));
    const s2 = reduceLifecycle(
      s1,
      'anomaly',
      event({ event: 'acknowledged', status: 'ACKNOWLEDGED', at: '2026-03-02T12:01:00Z' })
    );
    expect(s2.anomalies[7]).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledged_at: '2026-03-02T12:01:00Z',
    });
    expect(s2.anomalyFlash).toBe(s1.anomalyFlash);
    const s3 = reduceLifecycle(
      s2,
      'anomaly',
      event({ event: 'resolved', status: 'RESOLVED', at: '2026-03-02T12:05:00Z' })
    );
    expect(s3.anomalies[7]).toMatchObject({
      status: 'RESOLVED',
      resolved_at: '2026-03-02T12:05:00Z',
    });
  });

  it('keeps the fields it already had when a status event arrives', () => {
    const existing: AnomalyListItem = {
      id: 7,
      room: 'room204',
      sensor_id: 'temp-sensor-204',
      anomaly_category: 'z_score_spike',
      severity: 'CRITICAL',
      title: 'x',
      status: 'OPEN',
      detected_at: '2026-03-02T12:00:00Z',
      last_observed_at: '2026-03-02T12:00:00Z',
      acknowledged_at: null,
      resolved_at: null,
      observed_value: 34,
      expected_baseline: 23,
      deviation_score: 15,
      occurrence_count: 3,
    };
    const s = reduceLifecycle(
      { ...flash(), anomalies: { 7: existing } },
      'anomaly',
      event({ event: 'resolved', status: 'RESOLVED' })
    );
    expect(s.anomalies[7].observed_value).toBe(34);
    expect(s.anomalies[7].occurrence_count).toBe(3);
  });
});

describe('reduceLifecycle: threshold alerts', () => {
  it('creates and updates alerts, never touching the anomaly flash', () => {
    const created = reduceLifecycle(
      flash(),
      'alert',
      event({ id: 3, alert_type: 'critical_temperature', anomaly_category: undefined })
    );
    const alert: AlertListItem = created.alerts[3];
    expect(alert).toMatchObject({
      alert_type: 'critical_temperature',
      status: 'OPEN',
      room: 'room204',
    });
    expect(created.anomalyFlash).toBeNull();
    const resolved = reduceLifecycle(
      created,
      'alert',
      event({ id: 3, event: 'resolved', status: 'RESOLVED' })
    );
    expect(resolved.alerts[3].status).toBe('RESOLVED');
  });
});

describe('indexBy', () => {
  it('indexes by key', () => {
    expect(
      indexBy(
        [
          { id: 1, v: 'a' },
          { id: 2, v: 'b' },
        ],
        x => x.id
      )
    ).toEqual({ 1: { id: 1, v: 'a' }, 2: { id: 2, v: 'b' } });
  });
});
