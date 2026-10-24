import axios from 'axios';
import type {
  LatestDataResponse,
  RoomStatus,
  ActivityLog,
  HistoryResponse,
  RoomHistory,
  HealthResponse,
  AggregateResponse,
  RetentionStatus,
  SimulatorStatus,
  DetailedHealthResponse,
  BuildingLayout,
  Alert,
  AlertFilter,
  AlertListItem,
  AlertCountsResponse,
} from '../types';
import type {
  Anomaly,
  AnomalyContext,
  AnomalyListItem,
  EnergyResponse,
  ForecastResponse,
  InjectRequest,
  LatestReading,
  LifecycleStatus,
  MaintenanceResponse,
  Meta,
  ReplayResponse,
  ScenarioRequest,
  ScenarioResponse,
  SensorInfo,
  Topology,
} from '../types/nexus';
import { AUTH_REQUIRED_EVENT, getSession, setSession } from './auth';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

/** WebSocket endpoint derived from the REST base URL. */
export const WS_URL = `${API_BASE_URL.replace(/^http/, 'ws')}/ws/events`;

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 5000,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use(config => {
  const session = getSession();
  if (session) config.headers.set('Authorization', `Bearer ${session.token}`);
  return config;
});

api.interceptors.response.use(
  response => response,
  error => {
    const status = error.response?.status;
    if (status === 401) {
      setSession(null); // expired or invalid token
    }
    if (status === 401 || status === 403) {
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT, { detail: { status } }));
    }
    return Promise.reject(error);
  }
);

/** Human-readable message from an Axios/FastAPI error. */
export function errorMessage(err: unknown): string {
  const e = err as {
    response?: { data?: { detail?: unknown }; status?: number };
    message?: string;
  };
  const detail = e.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map(d => (d as { msg?: string }).msg ?? '').join('; ');
  if (e.response?.status === 401) return 'Sign in required';
  if (e.response?.status === 403) return 'Your role cannot do this';
  return e.message ?? 'Request failed';
}

export const healthApi = {
  check: async (): Promise<HealthResponse> => {
    const response = await api.get<HealthResponse>('/health');
    return response.data;
  },

  detailed: async (): Promise<DetailedHealthResponse> => {
    const response = await api.get<DetailedHealthResponse>('/health/detailed');
    return response.data;
  },
};

export const sensorApi = {
  getLatest: async (): Promise<LatestDataResponse[]> => {
    const response = await api.get<LatestDataResponse[]>('/api/latest');
    return response.data;
  },

  getStatus: async (): Promise<RoomStatus[]> => {
    const response = await api.get<RoomStatus[]>('/api/status');
    return response.data;
  },

  getRoomHistory: async (
    room: string,
    options: {
      sensor_id?: string;
      measurement?: string;
      start?: string;
      end?: string;
      limit?: number;
    } = {}
  ): Promise<HistoryResponse> => {
    const response = await api.get<HistoryResponse>(`/api/history/${room}`, { params: options });
    return response.data;
  },

  getAllHistory: async (
    options: {
      sensor_id?: string;
      measurement?: string;
      start?: string;
      end?: string;
      limit?: number;
      source?: 'simulated' | 'measured' | 'scenario';
    } = {}
  ): Promise<RoomHistory[]> => {
    const response = await api.get<RoomHistory[]>('/api/history', { params: options });
    return response.data;
  },

  getAggregate: async (options: {
    room: string;
    sensor_id: string;
    measurement?: string;
    start: string;
    end: string;
    interval?: string;
    source?: 'simulated' | 'measured' | 'scenario';
  }): Promise<AggregateResponse> => {
    const response = await api.get<AggregateResponse>('/api/telemetry/aggregate', {
      params: options,
    });
    return response.data;
  },
};

export const activityApi = {
  getLogs: async (limit = 50): Promise<ActivityLog[]> => {
    const response = await api.get<ActivityLog[]>('/api/activity', {
      params: { limit },
    });
    return response.data;
  },
};

export const retentionApi = {
  getStatus: async (): Promise<RetentionStatus> => {
    const response = await api.get<RetentionStatus>('/api/retention/status');
    return response.data;
  },

  runCleanup: async (): Promise<{ deleted_count: number; last_run: string | null }> => {
    const response = await api.post('/api/retention/run');
    return response.data;
  },
};

export const simulatorApi = {
  getStatus: async (): Promise<SimulatorStatus> => {
    const response = await api.get<SimulatorStatus>('/api/simulator/status');
    return response.data;
  },

  start: async (): Promise<{ status: string; running: boolean }> => {
    const response = await api.post('/api/simulator/start');
    return response.data;
  },

  stop: async (): Promise<{ status: string; running: boolean }> => {
    const response = await api.post('/api/simulator/stop');
    return response.data;
  },

  inject: async (body: InjectRequest) => {
    const response = await api.post<{
      sensor_id: string;
      kind: string;
      magnitude: number;
      started: string;
      until: string;
    }>('/api/simulator/inject', body);
    return response.data;
  },
};

export const layoutApi = {
  getLayout: async (): Promise<BuildingLayout> => {
    const response = await api.get<BuildingLayout>('/api/layout');
    return response.data;
  },
};

export const alertApi = {
  getAlerts: async (
    filter: AlertFilter & { start?: string; end?: string } = {}
  ): Promise<AlertListItem[]> => {
    const response = await api.get<AlertListItem[]>('/api/alerts', { params: filter });
    return response.data;
  },

  getAlert: async (alertId: number): Promise<Alert> => {
    const response = await api.get<Alert>(`/api/alerts/${alertId}`);
    return response.data;
  },

  // Lifecycle actions: the actor is taken from the auth token server-side.
  acknowledgeAlert: async (alertId: number): Promise<Alert> => {
    const response = await api.post<Alert>(`/api/alerts/${alertId}/acknowledge`, {});
    return response.data;
  },

  resolveAlert: async (alertId: number): Promise<Alert> => {
    const response = await api.post<Alert>(`/api/alerts/${alertId}/resolve`, {});
    return response.data;
  },

  getAlertCounts: async (): Promise<AlertCountsResponse> => {
    const response = await api.get<AlertCountsResponse>('/api/alerts/counts');
    return response.data;
  },
};

export const anomalyApi = {
  list: async (
    filter: {
      room?: string;
      sensor_id?: string;
      status?: LifecycleStatus;
      start?: string;
      end?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<AnomalyListItem[]> => {
    const response = await api.get<AnomalyListItem[]>('/api/anomalies', { params: filter });
    return response.data;
  },

  get: async (id: number): Promise<Anomaly> => {
    const response = await api.get<Anomaly>(`/api/anomalies/${id}`);
    return response.data;
  },

  context: async (id: number, windowMinutes?: number): Promise<AnomalyContext> => {
    const response = await api.get<AnomalyContext>(`/api/anomalies/${id}/context`, {
      params: windowMinutes ? { window_minutes: windowMinutes } : undefined,
    });
    return response.data;
  },

  acknowledge: async (id: number): Promise<Anomaly> => {
    const response = await api.post<Anomaly>(`/api/anomalies/${id}/acknowledge`, {});
    return response.data;
  },

  resolve: async (id: number): Promise<Anomaly> => {
    const response = await api.post<Anomaly>(`/api/anomalies/${id}/resolve`, {});
    return response.data;
  },
};

export const authApi = {
  login: async (username: string, password: string) => {
    const response = await api.post<{
      access_token: string;
      expires_in: number;
      username: string;
      role: 'viewer' | 'operator' | 'admin';
    }>('/api/auth/login', { username, password });
    const { access_token, expires_in, role } = response.data;
    setSession({
      username: response.data.username,
      role,
      token: access_token,
      expiresAt: Date.now() + expires_in * 1000,
    });
    return response.data;
  },
  logout: () => setSession(null),
};

export const nexusApi = {
  meta: async (): Promise<Meta> => (await api.get<Meta>('/api/meta')).data,
  topology: async (): Promise<Topology> => (await api.get<Topology>('/api/topology')).data,
  sensors: async (): Promise<SensorInfo[]> => (await api.get<SensorInfo[]>('/api/sensors')).data,
  latestReadings: async (): Promise<LatestReading[]> =>
    (await api.get<LatestReading[]>('/api/readings/latest')).data,

  replay: async (params: {
    start: string;
    end: string;
    floor?: number | null;
    max_points?: number;
    event_limit?: number;
    event_offset?: number;
  }): Promise<ReplayResponse> =>
    (
      await api.get<ReplayResponse>('/api/replay', {
        params: { ...params, floor: params.floor ?? undefined },
        timeout: 20000,
      })
    ).data,

  runScenario: async (body: ScenarioRequest): Promise<ScenarioResponse> =>
    (await api.post<ScenarioResponse>('/api/scenarios/run', body, { timeout: 20000 })).data,

  listScenarios: async () =>
    (
      await api.get<
        {
          id: number;
          label: string | null;
          created_by: string | null;
          created_at: string;
          sensor_id: string;
        }[]
      >('/api/scenarios')
    ).data,

  getScenario: async (id: number): Promise<ScenarioResponse> =>
    (await api.get<ScenarioResponse>(`/api/scenarios/${id}`)).data,

  maintenance: async (): Promise<MaintenanceResponse> =>
    (await api.get<MaintenanceResponse>('/api/maintenance')).data,

  forecast: async (sensorId: string, horizonMinutes = 30): Promise<ForecastResponse> =>
    (
      await api.get<ForecastResponse>('/api/forecast', {
        params: { sensor_id: sensorId, horizon_minutes: horizonMinutes },
      })
    ).data,

  energy: async (start?: string, end?: string): Promise<EnergyResponse> =>
    (await api.get<EnergyResponse>('/api/energy', { params: { start, end }, timeout: 15000 })).data,
};

export default api;
