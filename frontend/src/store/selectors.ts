import {
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_THRESHOLDS,
  sensorVisualState,
  worstState,
  type VisualState,
} from '../building/state';
import type { ReadingSourceName, ReplayEntity, ReplaySensor } from '../types/nexus';
import type { NexusState } from './index';
import { activeAt, stateAt } from './replay';

/** What one sensor looks like right now (live) or at the timeline cursor (replay). */
export interface SensorSnapshot {
  sensorId: string;
  type: string;
  unit: string;
  location: string | null;
  floor: number | null;
  /** Value to show. Null when there is no trustworthy reading (gap / never reported). */
  value: number | null;
  /** In a gap: the last value seen before it, shown only as "last known". */
  lastValue: number | null;
  timestampMs: number | null;
  source: ReadingSourceName | null;
  mode: 'live' | 'replay';
  /** The value is a bucket average, not a single reading. */
  aggregated: boolean;
  gap: boolean;
  visual: VisualState;
}

const replayIndex = new WeakMap<object, Map<string, ReplaySensor>>();

function replaySensor(state: NexusState, sensorId: string): ReplaySensor | undefined {
  const data = state.replay.data;
  if (!data) return undefined;
  let index = replayIndex.get(data);
  if (!index) {
    index = new Map(data.sensors.map(s => [s.sensor_id, s]));
    replayIndex.set(data, index);
  }
  return index.get(sensorId);
}

export function staleAfterMs(state: NexusState): number {
  return state.meta ? state.meta.stale_after_seconds * 1000 : DEFAULT_STALE_AFTER_MS;
}

export function thresholds(state: NexusState) {
  return state.meta?.thresholds ?? DEFAULT_THRESHOLDS;
}

export function isTimeTravel(state: NexusState): boolean {
  return state.cursor !== 'live';
}

export function snapshotFor(
  state: NexusState,
  sensorId: string,
  nowMs = Date.now()
): SensorSnapshot {
  const sensor = state.sensors[sensorId];
  const base = {
    sensorId,
    type: sensor?.type ?? 'unknown',
    unit: sensor?.unit ?? '',
    location: sensor?.location ?? null,
    floor: sensor?.floor ?? null,
  };
  const staleMs = staleAfterMs(state);
  const th = thresholds(state);

  // ---------------- time travel: only replayed data, never the live snapshot
  if (state.cursor !== 'live') {
    const cursor = state.cursor;
    const rs = replaySensor(state, sensorId);
    const result = rs ? stateAt(rs.points, cursor, state.meta?.stale_after_seconds ?? 120) : null;
    if (result?.kind === 'value') {
      return {
        ...base,
        value: result.point.v,
        lastValue: result.point.v,
        timestampMs: result.atMs,
        source: result.point.s ?? sensor?.source ?? 'simulated',
        mode: 'replay',
        aggregated: rs!.resolution === 'aggregated',
        gap: false,
        visual: sensorVisualState({
          value: result.point.v,
          type: base.type,
          timestampMs: result.atMs,
          nowMs: cursor,
          staleAfterMs: staleMs,
          thresholds: th,
        }),
      };
    }
    if (result?.kind === 'gap') {
      return {
        ...base,
        value: null,
        lastValue: result.lastPoint?.v ?? null,
        timestampMs: result.lastPoint ? Date.parse(result.lastPoint.t) : null,
        source: null,
        mode: 'replay',
        aggregated: false,
        gap: true,
        visual: 'stale',
      };
    }
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

  // ---------------- live
  const reading = state.latest[sensorId];
  const timestampMs = reading
    ? Date.parse(reading.event_timestamp)
    : sensor?.last_seen_at
      ? Date.parse(sensor.last_seen_at)
      : null;
  const value = reading?.value ?? null;
  return {
    ...base,
    value,
    lastValue: value,
    timestampMs,
    source: reading?.source ?? null,
    mode: 'live',
    aggregated: false,
    gap: false,
    visual: sensorVisualState({
      value,
      type: base.type,
      timestampMs,
      nowMs,
      staleAfterMs: staleMs,
      thresholds: th,
    }),
  };
}

export function roomSensorIds(state: NexusState, roomCode: string): string[] {
  for (const f of state.topology?.floors ?? []) {
    const room = f.rooms.find(r => r.code === roomCode);
    if (room) return room.sensors.map(s => s.sensor_id);
  }
  return [];
}

export function roomVisual(state: NexusState, roomCode: string, nowMs = Date.now()): VisualState {
  const ids = roomSensorIds(state, roomCode);
  if (!ids.length) return 'offline';
  return worstState(ids.map(id => snapshotFor(state, id, nowMs).visual));
}

export interface ActiveEntities {
  /** Rooms (or asset codes) that currently have an open/acknowledged alert. */
  alertRooms: Set<string>;
  /** room -> open/acknowledged anomaly ids. */
  anomaliesByRoom: Map<string, number[]>;
}

/** Open alerts/anomalies now, or as they were at the cursor when time travelling. */
export function activeEntities(state: NexusState): ActiveEntities {
  const alertRooms = new Set<string>();
  const anomaliesByRoom = new Map<string, number[]>();
  const add = (room: string, id: number) =>
    anomaliesByRoom.set(room, [...(anomaliesByRoom.get(room) ?? []), id]);

  if (state.cursor === 'live') {
    for (const a of Object.values(state.alerts))
      if (a.status !== 'RESOLVED') alertRooms.add(a.room);
    for (const a of Object.values(state.anomalies)) if (a.status !== 'RESOLVED') add(a.room, a.id);
  } else if (state.replay.data) {
    const t = state.cursor;
    const live = (list: ReplayEntity[]) => activeAt(list, t);
    for (const a of live(state.replay.data.alerts)) alertRooms.add(a.room);
    for (const a of live(state.replay.data.anomalies)) add(a.room, a.id);
  }
  return { alertRooms, anomaliesByRoom };
}

/** The sensor shown in the inspector: explicit selection, else the selected room's first sensor. */
export function selectedSensorId(state: NexusState): string | null {
  if (state.selection.sensor) return state.selection.sensor;
  if (state.selection.room) return roomSensorIds(state, state.selection.room)[0] ?? null;
  return null;
}
