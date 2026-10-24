import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnomalyListItem, ReplayResponse, StreamEnvelope } from '../types/nexus';

vi.mock('../api/client', () => ({
  alertApi: {
    getAlerts: vi.fn().mockResolvedValue([]),
    getAlertCounts: vi.fn().mockResolvedValue({ total: 0, by_severity: [], by_status: [] }),
    acknowledgeAlert: vi.fn(),
    resolveAlert: vi.fn(),
  },
  anomalyApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    context: vi.fn(),
    acknowledge: vi.fn(),
    resolve: vi.fn(),
  },
  nexusApi: {
    meta: vi.fn(),
    topology: vi.fn(),
    sensors: vi.fn().mockResolvedValue([]),
    latestReadings: vi.fn().mockResolvedValue([]),
    replay: vi.fn(),
  },
  errorMessage: (e: unknown) => (e as Error).message,
}));

import { anomalyApi, nexusApi } from '../api/client';
import { resetNexus, useNexus } from './index';
import { activeEntities, snapshotFor } from './selectors';

const T0 = Date.parse('2026-03-02T12:00:00Z');
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const anomaly = (over: Partial<AnomalyListItem> = {}): AnomalyListItem => ({
  id: 5,
  room: 'room101',
  sensor_id: 'temp-sensor-101',
  anomaly_category: 'z_score_spike',
  severity: 'WARNING',
  title: 'spike',
  status: 'OPEN',
  detected_at: iso(0),
  last_observed_at: iso(0),
  acknowledged_at: null,
  resolved_at: null,
  observed_value: 33,
  expected_baseline: 22,
  deviation_score: 9,
  occurrence_count: 1,
  ...over,
});

function replayFixture(): ReplayResponse {
  return {
    start: iso(-600),
    end: iso(600),
    requested_start: iso(-600),
    clamped_to_retention: false,
    retention_days: 30,
    retention_floor: iso(-9e6),
    floor: null,
    max_points: 600,
    bucket_seconds: 1,
    stale_after_seconds: 120,
    event_total: 0,
    event_offset: 0,
    event_limit: 500,
    truncated: false,
    sensors: [
      {
        sensor_id: 'temp-sensor-101',
        location: 'room101',
        type: 'temperature',
        unit: 'celsius',
        source: 'simulated',
        floor: 0,
        resolution: 'raw',
        sample_count: 3,
        points: [
          { t: iso(-300), v: 22.0, n: 1 },
          { t: iso(-240), v: 22.5, n: 1 },
          { t: iso(300), v: 23.0, n: 1 },
        ],
      },
    ],
    alerts: [],
    anomalies: [
      {
        id: 5,
        room: 'room101',
        sensor_id: 'temp-sensor-101',
        type: 'z_score_spike',
        severity: 'WARNING',
        status: 'RESOLVED',
        title: 'spike',
        started_at: iso(-250),
        acknowledged_at: null,
        resolved_at: iso(-200),
      },
    ],
    events: [],
  };
}

beforeEach(() => {
  resetNexus();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  useNexus.setState({
    meta: {
      stale_after_seconds: 120,
      thresholds: { warning: 30, critical: 35, recovery: 28 },
    } as never,
    sensors: {
      'temp-sensor-101': {
        sensor_id: 'temp-sensor-101',
        type: 'temperature',
        unit: 'celsius',
        source: 'simulated',
        enabled: true,
        last_seen_at: null,
        location: 'room101',
        floor: 0,
      },
    },
    latest: {
      'temp-sensor-101': {
        sensor_id: 'temp-sensor-101',
        room: 'room101',
        measurement: 'temperature',
        value: 36.0,
        unit: 'celsius',
        source: 'simulated',
        event_timestamp: iso(0),
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('applyEvent', () => {
  it('a reading updates the latest value and pulses the sensor', () => {
    const env: StreamEnvelope = {
      seq: 2,
      type: 'reading',
      ts: null,
      data: {
        sensor_id: 'temp-sensor-101',
        room: 'room101',
        measurement: 'temperature',
        value: 24.0,
        unit: 'celsius',
        source: 'simulated',
        event_timestamp: iso(5),
        room_status: 'NORMAL',
      },
    };
    useNexus.getState().applyEvent(env);
    const s = useNexus.getState();
    expect(s.latest['temp-sensor-101'].value).toBe(24.0);
    expect(s.pulses['temp-sensor-101']).toBe(1);
    expect(s.connection.lastEventAt).not.toBeNull();
  });

  it('a new anomaly event flashes the scene and then reconciles over REST', async () => {
    vi.mocked(anomalyApi.list).mockResolvedValue([anomaly()]);
    useNexus.getState().applyEvent({
      seq: 3,
      type: 'anomaly',
      ts: null,
      data: {
        event: 'created',
        id: 5,
        room: 'room101',
        sensor_id: 'temp-sensor-101',
        severity: 'WARNING',
        status: 'OPEN',
        title: 'spike',
        actor: 'system',
        at: iso(0),
        anomaly_category: 'z_score_spike',
      },
    });
    expect(useNexus.getState().anomalyFlash?.id).toBe(5);
    expect(useNexus.getState().anomalies[5]).toBeDefined();
    await vi.advanceTimersByTimeAsync(400);
    expect(anomalyApi.list).toHaveBeenCalled();
    expect(useNexus.getState().anomalies[5].observed_value).toBe(33); // the persisted record replaced the placeholder
  });
});

describe('lifecycle actions never succeed optimistically', () => {
  beforeEach(() => useNexus.setState({ anomalies: { 5: anomaly() } }));

  it('status changes only after the backend confirms', async () => {
    let confirm!: (v: unknown) => void;
    vi.mocked(anomalyApi.acknowledge).mockReturnValue(new Promise(res => (confirm = res)) as never);
    const done = useNexus.getState().acknowledgeAnomaly(5);

    expect(useNexus.getState().pending['anomaly:5:ack']).toBe(true);
    expect(useNexus.getState().anomalies[5].status).toBe('OPEN'); // still open while in flight

    confirm({
      ...anomaly(),
      status: 'ACKNOWLEDGED',
      acknowledged_at: iso(10),
      acknowledged_by: 'operator',
      description: '',
      metadata: null,
      created_at: '',
      updated_at: '',
    });
    expect(await done).toBe(true);
    expect(useNexus.getState().anomalies[5].status).toBe('ACKNOWLEDGED');
    expect(useNexus.getState().pending['anomaly:5:ack']).toBeUndefined();
  });

  it('a failure is reported and the status is left alone', async () => {
    vi.mocked(anomalyApi.resolve).mockRejectedValue(new Error('Requires role operator'));
    expect(await useNexus.getState().resolveAnomaly(5)).toBe(false);
    const s = useNexus.getState();
    expect(s.anomalies[5].status).toBe('OPEN');
    expect(s.actionError).toEqual({ key: 'anomaly:5:resolve', message: 'Requires role operator' });
    expect(s.pending).toEqual({});
  });
});

describe('time travel', () => {
  beforeEach(() => {
    useNexus.setState({
      cursor: 'live',
      replay: {
        status: 'ready',
        data: replayFixture(),
        error: null,
        startMs: T0 - 600_000,
        endMs: T0 + 600_000,
      },
    });
  });

  it('live: the snapshot is the streamed value', () => {
    const snap = snapshotFor(useNexus.getState(), 'temp-sensor-101', T0);
    expect(snap).toMatchObject({ value: 36.0, mode: 'live', visual: 'critical', gap: false });
  });

  it('replay: state at T comes from replayed data, never from the live snapshot', () => {
    useNexus.setState({ cursor: T0 - 270_000 });
    const snap = snapshotFor(useNexus.getState(), 'temp-sensor-101');
    expect(snap).toMatchObject({ value: 22.0, mode: 'replay', gap: false, visual: 'normal' });
    expect(snap.value).not.toBe(36.0);
  });

  it('replay: a gap shows as a gap, not as the current value', () => {
    useNexus.setState({ cursor: T0 + 100_000 }); // 340 s after the last replayed reading
    const snap = snapshotFor(useNexus.getState(), 'temp-sensor-101');
    expect(snap).toMatchObject({
      value: null,
      lastValue: 22.5,
      gap: true,
      visual: 'stale',
      mode: 'replay',
    });
  });

  it('replay: before any reading there is no data at all', () => {
    useNexus.setState({ cursor: T0 - 590_000 });
    expect(snapshotFor(useNexus.getState(), 'temp-sensor-101')).toMatchObject({
      value: null,
      gap: true,
      visual: 'offline',
    });
  });

  it('active anomalies at T come from the replay, and the live list is ignored', () => {
    useNexus.setState({ anomalies: { 5: anomaly({ status: 'OPEN' }) } });
    expect(activeEntities(useNexus.getState()).anomaliesByRoom.get('room101')).toEqual([5]); // live
    useNexus.setState({ cursor: T0 - 225_000 }); // inside [started, resolved)
    expect(activeEntities(useNexus.getState()).anomaliesByRoom.get('room101')).toEqual([5]);
    useNexus.setState({ cursor: T0 - 100_000 }); // after it was resolved in the past
    expect(activeEntities(useNexus.getState()).anomaliesByRoom.size).toBe(0);
  });

  it('setCursor outside the loaded window reloads the replay around it', async () => {
    vi.mocked(nexusApi.replay).mockResolvedValue(replayFixture());
    await useNexus.getState().setCursor(T0 - 5_000_000);
    expect(nexusApi.replay).toHaveBeenCalledTimes(1);
    expect(useNexus.getState().ui.timelineOpen).toBe(true);
  });

  it('goLive drops the cursor and stops playback', () => {
    useNexus.setState({ cursor: T0 - 1000, playback: { playing: true, speed: 10 } });
    useNexus.getState().goLive();
    expect(useNexus.getState().cursor).toBe('live');
    expect(useNexus.getState().playback.playing).toBe(false);
  });

  it('playback advances the cursor and returns to live at the end of the window', () => {
    useNexus.setState({ cursor: T0 + 590_000 });
    useNexus.getState().advance(5_000);
    expect(useNexus.getState().cursor).toBe(T0 + 595_000);
    useNexus.getState().advance(10_000);
    expect(useNexus.getState().cursor).toBe('live');
  });

  it('advance is a no-op while live', () => {
    useNexus.getState().advance(10_000);
    expect(useNexus.getState().cursor).toBe('live');
  });
});

describe('selection', () => {
  beforeEach(() => {
    useNexus.setState({
      topology: {
        building: { code: 'hq', name: 'B', timezone: 'UTC' },
        floors: [
          {
            level: 1,
            name: 'F1',
            elevation_m: 4,
            height_m: 4,
            assets: [],
            rooms: [{ code: 'room201', name: 'R', x: 0, z: 0, width: 5, depth: 5, sensors: [] }],
          },
        ],
      },
    });
  });

  it('selecting a room does not start floor isolation', () => {
    useNexus.getState().select({ room: 'room201' });
    expect(useNexus.getState().selection.floor).toBeNull();
    expect(useNexus.getState().ui.inspectorOpen).toBe(true);
  });

  it('while a floor is isolated, selecting a room elsewhere moves the isolation with it', () => {
    useNexus.setState({
      selection: { floor: 0, room: null, sensor: null, anomalyId: null, alertId: null },
    });
    useNexus.getState().select({ room: 'room201' });
    expect(useNexus.getState().selection.floor).toBe(1);
  });
});
