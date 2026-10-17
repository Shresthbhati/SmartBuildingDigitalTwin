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
  AlertListItem,
  AlertCountsResponse,
} from '../types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 5000,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.response.use(
  response => response,
  error => {
    console.error('API Error:', error.response?.data || error.message);
    return Promise.reject(error);
  }
);

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
    const params = new URLSearchParams();
    if (options.sensor_id) params.append('sensor_id', options.sensor_id);
    if (options.measurement) params.append('measurement', options.measurement);
    if (options.start) params.append('start', options.start);
    if (options.end) params.append('end', options.end);
    if (options.limit) params.append('limit', options.limit.toString());

    const response = await api.get<HistoryResponse>(`/api/history/${room}`, { params });
    return response.data;
  },

  getAllHistory: async (
    options: {
      sensor_id?: string;
      measurement?: string;
      start?: string;
      end?: string;
      limit?: number;
      source?: 'simulated' | 'measured';
    } = {}
  ): Promise<RoomHistory[]> => {
    const params = new URLSearchParams();
    if (options.sensor_id) params.append('sensor_id', options.sensor_id);
    if (options.measurement) params.append('measurement', options.measurement);
    if (options.start) params.append('start', options.start);
    if (options.end) params.append('end', options.end);
    if (options.limit) params.append('limit', options.limit.toString());
    if (options.source) params.append('source', options.source);

    const response = await api.get<RoomHistory[]>('/api/history', { params });
    return response.data;
  },

  getAggregate: async (options: {
    room: string;
    sensor_id: string;
    measurement?: string;
    start: string;
    end: string;
    interval?: string;
    source?: 'simulated' | 'measured';
  }): Promise<AggregateResponse> => {
    const params = new URLSearchParams();
    params.append('room', options.room);
    params.append('sensor_id', options.sensor_id);
    if (options.measurement) params.append('measurement', options.measurement);
    params.append('start', options.start);
    params.append('end', options.end);
    if (options.interval) params.append('interval', options.interval);
    if (options.source) params.append('source', options.source);

    const response = await api.get<AggregateResponse>('/api/telemetry/aggregate', { params });
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
};

export const layoutApi = {
  getLayout: async (): Promise<BuildingLayout> => {
    const response = await api.get<BuildingLayout>('/api/layout');
    return response.data;
  },
};

export const alertApi = {
  getAlerts: async (filter: AlertFilter = {}): Promise<AlertListItem[]> => {
    const params = new URLSearchParams();
    if (filter.room) params.append('room', filter.room);
    if (filter.sensor_id) params.append('sensor_id', filter.sensor_id);
    if (filter.alert_type) params.append('alert_type', filter.alert_type);
    if (filter.severity) params.append('severity', filter.severity);
    if (filter.status) params.append('status', filter.status);
    if (filter.limit !== undefined) params.append('limit', filter.limit.toString());
    if (filter.offset !== undefined) params.append('offset', filter.offset.toString());
    if (filter.sort_by) params.append('sort_by', filter.sort_by);
    if (filter.sort_order) params.append('sort_order', filter.sort_order);

    const response = await api.get<AlertListItem[]>('/api/alerts', { params });
    return response.data;
  },

  getAlert: async (alertId: number): Promise<Alert> => {
    const response = await api.get<Alert>(`/api/alerts/${alertId}`);
    return response.data;
  },

  acknowledgeAlert: async (alertId: number, actor?: string): Promise<Alert> => {
    const response = await api.post<Alert>(
      `/api/alerts/${alertId}/acknowledge`,
      actor ? { actor } : {}
    );
    return response.data;
  },

  resolveAlert: async (alertId: number, actor?: string): Promise<Alert> => {
    const response = await api.post<Alert>(
      `/api/alerts/${alertId}/resolve`,
      actor ? { actor } : {}
    );
    return response.data;
  },

  getAlertCounts: async (): Promise<AlertCountsResponse> => {
    const response = await api.get<AlertCountsResponse>('/api/alerts/counts');
    return response.data;
  },
};

export default api;
