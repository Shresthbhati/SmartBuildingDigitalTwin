import { create } from 'zustand';
import { alertApi, anomalyApi, errorMessage, nexusApi } from '../api/client';
import type { Alert, AlertCountsResponse, AlertListItem } from '../types';
import type {
  Anomaly,
  AnomalyContext,
  AnomalyListItem,
  ConnectionState,
  HealthEventData,
  LatestReading,
  LifecycleStatus,
  Meta,
  ReplayResponse,
  SensorInfo,
  StreamEnvelope,
  Topology,
} from '../types/nexus';
import { indexBy, reduceLifecycle, reduceReading } from './reducers';

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export type Mode = 'observe' | 'investigate' | 'anticipate' | 'experiment' | 'system';

export interface Selection {
  floor: number | null;
  room: string | null;
  sensor: string | null;
  anomalyId: number | null;
  alertId: number | null;
}

export interface ReplayState {
  status: LoadState;
  data: ReplayResponse | null;
  error: string | null;
  startMs: number;
  endMs: number;
}

export interface FocusRequest {
  room?: string;
  sensor?: string;
  floor?: number;
  nonce: number;
}

export const EMPTY_SELECTION: Selection = {
  floor: null,
  room: null,
  sensor: null,
  anomalyId: null,
  alertId: null,
};

export interface NexusState {
  // ---- server truth (REST + stream)
  meta: Meta | null;
  topology: Topology | null;
  sensors: Record<string, SensorInfo>;
  latest: Record<string, LatestReading>;
  alerts: Record<number, AlertListItem>;
  anomalies: Record<number, AnomalyListItem>;
  alertCounts: AlertCountsResponse | null;
  details: Record<number, Anomaly>;
  contexts: Record<
    number,
    { status: LoadState; data: AnomalyContext | null; error: string | null }
  >;
  health: HealthEventData | null;
  // ---- one-shot signals for the scene (never data)
  pulses: Record<string, number>;
  anomalyFlash: { id: number; room: string; sensorId: string; nonce: number } | null;
  focusRequest: FocusRequest | null;
  // ---- connection + loading
  connection: {
    state: ConnectionState;
    attempt: number;
    retryInMs: number | null;
    lastEventAt: number | null;
  };
  load: { meta: LoadState; topology: LoadState; snapshot: LoadState };
  errors: {
    meta?: string;
    topology?: string;
    readings?: string;
    alerts?: string;
    anomalies?: string;
  };
  // ---- UI state
  mode: Mode;
  selection: Selection;
  ui: { inspectorOpen: boolean; timelineOpen: boolean; view: '3d' | 'list' };
  // ---- time travel
  cursor: number | 'live';
  replay: ReplayState;
  playback: { playing: boolean; speed: number };
  // ---- lifecycle actions in flight / last failure
  pending: Record<string, boolean>;
  actionError: { key: string; message: string } | null;
}

export interface NexusActions {
  bootstrap: () => Promise<void>;
  loadSnapshot: (quiet?: boolean) => Promise<void>;
  refreshEvents: () => Promise<void>;
  applyEvent: (env: StreamEnvelope) => void;
  setConnection: (
    state: ConnectionState,
    info?: { attempt?: number; retryInMs?: number | null }
  ) => void;
  setMode: (mode: Mode) => void;
  select: (patch: Partial<Selection>) => void;
  clearSelection: () => void;
  requestFocus: (target: Omit<FocusRequest, 'nonce'>) => void;
  setUi: (patch: Partial<NexusState['ui']>) => void;
  setCursor: (cursor: number | 'live') => Promise<void>;
  goLive: () => void;
  loadReplay: (opts?: { windowMs?: number; centerMs?: number }) => Promise<void>;
  setPlayback: (patch: Partial<NexusState['playback']>) => void;
  advance: (ms: number) => void;
  loadAnomalyDetail: (id: number) => Promise<void>;
  loadAnomalyContext: (id: number) => Promise<void>;
  acknowledgeAnomaly: (id: number) => Promise<boolean>;
  resolveAnomaly: (id: number) => Promise<boolean>;
  acknowledgeAlert: (id: number) => Promise<boolean>;
  resolveAlert: (id: number) => Promise<boolean>;
  dismissActionError: () => void;
}

export type NexusStore = NexusState & NexusActions;

const REFRESH_DEBOUNCE_MS = 300;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let replayToken = 0;

function indexSensors(topology: Topology): Record<string, SensorInfo> {
  const out: Record<string, SensorInfo> = {};
  for (const floor of topology.floors) {
    for (const room of floor.rooms) for (const s of room.sensors) out[s.sensor_id] = s;
    for (const asset of floor.assets) for (const s of asset.sensors) out[s.sensor_id] = s;
  }
  return out;
}

function alertToListItem(a: Alert): AlertListItem {
  return {
    id: a.id,
    room: a.room,
    sensor_id: a.sensor_id,
    alert_type: a.alert_type,
    severity: a.severity,
    title: a.title,
    status: a.status,
    first_occurrence: a.first_occurrence,
    last_occurrence: a.last_occurrence,
    acknowledged_at: a.acknowledged_at,
    resolved_at: a.resolved_at,
    last_reading_value: a.last_reading_value,
    occurrence_count: a.occurrence_count,
  };
}

export const initialState: NexusState = {
  meta: null,
  topology: null,
  sensors: {},
  latest: {},
  alerts: {},
  anomalies: {},
  alertCounts: null,
  details: {},
  contexts: {},
  health: null,
  pulses: {},
  anomalyFlash: null,
  focusRequest: null,
  connection: { state: 'connecting', attempt: 0, retryInMs: null, lastEventAt: null },
  load: { meta: 'idle', topology: 'idle', snapshot: 'idle' },
  errors: {},
  mode: 'observe',
  selection: EMPTY_SELECTION,
  // On narrow screens the inspector is a bottom sheet over the scene: start it collapsed
  // (selecting something still opens it).
  ui: {
    inspectorOpen: typeof window === 'undefined' || window.innerWidth >= 900,
    timelineOpen: false,
    view: '3d',
  },
  cursor: 'live',
  replay: { status: 'idle', data: null, error: null, startMs: 0, endMs: 0 },
  playback: { playing: false, speed: 4 },
  pending: {},
  actionError: null,
};

export const useNexus = create<NexusStore>((set, get) => {
  /** Run a lifecycle action. No optimistic update: state changes only after the backend says so. */
  async function runAction<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    set(s => ({ pending: { ...s.pending, [key]: true }, actionError: null }));
    try {
      return await fn();
    } catch (err) {
      set({ actionError: { key, message: errorMessage(err) } });
      return null;
    } finally {
      set(s => {
        const rest = { ...s.pending };
        delete rest[key];
        return { pending: rest };
      });
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void get().refreshEvents();
    }, REFRESH_DEBOUNCE_MS);
  }

  return {
    ...initialState,

    // ------------------------------------------------------------------ loading
    bootstrap: async () => {
      set(s => ({ load: { ...s.load, meta: 'loading', topology: 'loading' } }));
      await Promise.all([
        nexusApi
          .meta()
          .then(meta => set(s => ({ meta, load: { ...s.load, meta: 'ready' } })))
          .catch(err =>
            set(s => ({
              load: { ...s.load, meta: 'error' },
              errors: { ...s.errors, meta: errorMessage(err) },
            }))
          ),
        nexusApi
          .topology()
          .then(topology =>
            set(s => ({
              topology,
              sensors: indexSensors(topology),
              load: { ...s.load, topology: 'ready' },
              errors: { ...s.errors, topology: undefined },
            }))
          )
          .catch(err =>
            set(s => ({
              load: { ...s.load, topology: 'error' },
              errors: { ...s.errors, topology: errorMessage(err) },
            }))
          ),
      ]);
      await get().loadSnapshot();
    },

    loadSnapshot: async (quiet = false) => {
      if (!quiet) set(s => ({ load: { ...s.load, snapshot: 'loading' } }));
      const [readings, alerts, anomalies, counts, sensors] = await Promise.allSettled([
        nexusApi.latestReadings(),
        alertApi.getAlerts({ limit: 200 }),
        anomalyApi.list({ limit: 200 }),
        alertApi.getAlertCounts(),
        nexusApi.sensors(),
      ]);
      const errors: NexusState['errors'] = {};
      const patch: Partial<NexusState> = {};
      if (readings.status === 'fulfilled') patch.latest = indexBy(readings.value, r => r.sensor_id);
      else errors.readings = errorMessage(readings.reason);
      if (alerts.status === 'fulfilled') patch.alerts = indexBy(alerts.value, a => a.id);
      else errors.alerts = errorMessage(alerts.reason);
      if (anomalies.status === 'fulfilled') patch.anomalies = indexBy(anomalies.value, a => a.id);
      else errors.anomalies = errorMessage(anomalies.reason);
      if (counts.status === 'fulfilled') patch.alertCounts = counts.value;
      const failed = [readings, alerts, anomalies].filter(r => r.status === 'rejected').length;
      set(s => ({
        ...patch,
        sensors:
          sensors.status === 'fulfilled'
            ? { ...s.sensors, ...indexBy(sensors.value, x => x.sensor_id) }
            : s.sensors,
        errors: {
          ...s.errors,
          ...errors,
          readings: errors.readings,
          alerts: errors.alerts,
          anomalies: errors.anomalies,
        },
        // Partial failures keep what loaded; only a total failure is an error state.
        load: { ...s.load, snapshot: failed === 3 ? 'error' : 'ready' },
      }));
    },

    refreshEvents: async () => {
      const [alerts, anomalies, counts] = await Promise.allSettled([
        alertApi.getAlerts({ limit: 200 }),
        anomalyApi.list({ limit: 200 }),
        alertApi.getAlertCounts(),
      ]);
      set(s => ({
        alerts: alerts.status === 'fulfilled' ? indexBy(alerts.value, a => a.id) : s.alerts,
        anomalies:
          anomalies.status === 'fulfilled' ? indexBy(anomalies.value, a => a.id) : s.anomalies,
        alertCounts: counts.status === 'fulfilled' ? counts.value : s.alertCounts,
      }));
    },

    // ------------------------------------------------------------------ stream
    applyEvent: env => {
      switch (env.type) {
        case 'reading':
          set(s => ({
            ...reduceReading({ latest: s.latest, sensors: s.sensors, pulses: s.pulses }, env.data),
            connection: { ...s.connection, lastEventAt: Date.now() },
          }));
          break;
        case 'alert':
        case 'anomaly':
          set(s => ({
            ...reduceLifecycle(
              { alerts: s.alerts, anomalies: s.anomalies, anomalyFlash: s.anomalyFlash },
              env.type as 'alert' | 'anomaly',
              env.data
            ),
            connection: { ...s.connection, lastEventAt: Date.now() },
          }));
          scheduleRefresh(); // reconcile the optimistic-from-event record with the persisted one
          break;
        case 'health':
          set(s => ({
            health: env.data,
            connection: { ...s.connection, lastEventAt: Date.now() },
          }));
          break;
      }
    },

    setConnection: (state, info) =>
      set(s => ({
        connection: {
          ...s.connection,
          state,
          attempt: info?.attempt ?? s.connection.attempt,
          retryInMs: info?.retryInMs ?? null,
        },
      })),

    // ------------------------------------------------------------------ selection
    setMode: mode => set({ mode }),

    select: patch =>
      set(s => {
        const next = { ...s.selection, ...patch };
        // Selecting something never starts floor isolation; but while a floor is isolated the
        // isolation follows the selection (e.g. a deep link or "focus" into another floor).
        if (s.selection.floor !== null && patch.floor === undefined) {
          if (patch.room && s.topology) {
            const floor = s.topology.floors.find(f => f.rooms.some(r => r.code === patch.room));
            if (floor) next.floor = floor.level;
          } else if (patch.sensor) {
            const floor = s.sensors[patch.sensor]?.floor;
            if (floor !== undefined && floor !== null) next.floor = floor;
          }
        }
        return { selection: next, ui: { ...s.ui, inspectorOpen: true } };
      }),

    clearSelection: () =>
      set(s => ({ selection: { ...EMPTY_SELECTION, floor: s.selection.floor } })),

    requestFocus: target =>
      set(s => ({ focusRequest: { ...target, nonce: (s.focusRequest?.nonce ?? 0) + 1 } })),

    setUi: patch => set(s => ({ ui: { ...s.ui, ...patch } })),

    // ------------------------------------------------------------------ time travel
    loadReplay: async (opts = {}) => {
      const token = ++replayToken;
      const now = Date.now();
      const prev = get().replay;
      const windowMs =
        opts.windowMs ??
        (prev.endMs > prev.startMs ? prev.endMs - prev.startMs : DEFAULT_WINDOW_MS);
      const endMs = now;
      // If the cursor (or a deep link) is older than the window, reach back to include it.
      const startMs = Math.min(
        now - windowMs,
        (opts.centerMs ?? Infinity) - Math.round(windowMs * 0.1)
      );
      set(s => ({ replay: { ...s.replay, status: 'loading', error: null, startMs, endMs } }));
      try {
        const data = await nexusApi.replay({
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
        });
        if (token !== replayToken) return; // a newer request superseded this one
        set(s => ({
          replay: {
            status: 'ready',
            data,
            error: null,
            // The server may have clamped the start to the retention floor.
            startMs: Date.parse(data.start),
            endMs: Date.parse(data.end),
          },
          // Keep the cursor inside what we can actually show.
          cursor:
            typeof s.cursor === 'number'
              ? Math.min(Math.max(s.cursor, Date.parse(data.start)), Date.parse(data.end))
              : s.cursor,
        }));
      } catch (err) {
        if (token !== replayToken) return;
        set(s => ({ replay: { ...s.replay, status: 'error', error: errorMessage(err) } }));
      }
    },

    setCursor: async cursor => {
      if (cursor === 'live') {
        get().goLive();
        return;
      }
      const { replay } = get();
      set(s => ({ cursor, ui: { ...s.ui, timelineOpen: true } }));
      const covered = replay.data && cursor >= replay.startMs && cursor <= replay.endMs;
      if (!covered && replay.status !== 'loading') await get().loadReplay({ centerMs: cursor });
    },

    goLive: () => set(s => ({ cursor: 'live', playback: { ...s.playback, playing: false } })),

    setPlayback: patch => set(s => ({ playback: { ...s.playback, ...patch } })),

    advance: ms => {
      const { cursor, replay } = get();
      if (cursor === 'live') return;
      const next = cursor + ms;
      if (replay.endMs && next >= replay.endMs) get().goLive();
      else set({ cursor: next });
    },

    // ------------------------------------------------------------------ investigation
    loadAnomalyDetail: async id => {
      if (get().details[id]) return;
      try {
        const detail = await anomalyApi.get(id);
        set(s => ({ details: { ...s.details, [id]: detail } }));
      } catch (err) {
        set({ actionError: { key: `anomaly:${id}:detail`, message: errorMessage(err) } });
      }
    },

    loadAnomalyContext: async id => {
      set(s => ({
        contexts: {
          ...s.contexts,
          [id]: { status: 'loading', data: s.contexts[id]?.data ?? null, error: null },
        },
      }));
      try {
        const data = await anomalyApi.context(id);
        set(s => ({ contexts: { ...s.contexts, [id]: { status: 'ready', data, error: null } } }));
      } catch (err) {
        set(s => ({
          contexts: {
            ...s.contexts,
            [id]: { status: 'error', data: null, error: errorMessage(err) },
          },
        }));
      }
    },

    acknowledgeAnomaly: id =>
      lifecycle(`anomaly:${id}:ack`, () => anomalyApi.acknowledge(id), anomalyUpdate(id)),
    resolveAnomaly: id =>
      lifecycle(`anomaly:${id}:resolve`, () => anomalyApi.resolve(id), anomalyUpdate(id)),
    acknowledgeAlert: id =>
      lifecycle(`alert:${id}:ack`, () => alertApi.acknowledgeAlert(id), alertUpdate),
    resolveAlert: id =>
      lifecycle(`alert:${id}:resolve`, () => alertApi.resolveAlert(id), alertUpdate),

    dismissActionError: () => set({ actionError: null }),
  };

  // --- helpers that need set/get (hoisted function declarations inside the factory) ---
  async function lifecycle<T>(
    key: string,
    call: () => Promise<T>,
    apply: (r: T) => void
  ): Promise<boolean> {
    const result = await runAction(key, call);
    if (result === null) return false;
    apply(result); // only now, after the backend confirmed
    void get().refreshEvents();
    return true;
  }

  function anomalyUpdate(id: number) {
    return (a: Anomaly) =>
      set(s => ({
        details: { ...s.details, [id]: a },
        anomalies: s.anomalies[id]
          ? {
              ...s.anomalies,
              [id]: {
                ...s.anomalies[id],
                status: a.status as LifecycleStatus,
                acknowledged_at: a.acknowledged_at,
                resolved_at: a.resolved_at,
              },
            }
          : s.anomalies,
      }));
  }

  function alertUpdate(a: Alert) {
    set(s => ({ alerts: { ...s.alerts, [a.id]: alertToListItem(a) } }));
  }
});

/** Test helper: reset the store between tests. */
export function resetNexus(): void {
  useNexus.setState({ ...initialState }, false);
  replayToken = 0;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}
