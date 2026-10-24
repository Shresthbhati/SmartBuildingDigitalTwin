export interface SensorReading {
  id: number;
  room: string;
  sensor_id: string;
  measurement: string;
  value: number;
  unit: string;
  source: 'simulated' | 'measured';
  event_timestamp: string;
  ingestion_timestamp: string;
  idempotency_key: string | null;
}

export interface RoomStatus {
  room: string;
  status: 'NORMAL' | 'HIGH' | 'ALERT';
  current_temperature: number | null;
  last_updated: string;
}

export interface ActivityLog {
  id: number;
  room: string;
  message: string;
  level: string;
  timestamp: string;
}

export interface LatestDataResponse {
  room: string;
  temperature: number;
  status: 'NORMAL' | 'HIGH' | 'ALERT';
}

export interface HistoryResponse {
  room: string;
  readings: SensorReading[];
}

export interface HealthResponse {
  status: 'healthy' | 'degraded';
  version: string;
  database: string;
  mqtt: string;
}

export interface RoomHistory {
  room: string;
  readings: SensorReading[];
}

// Aggregation types
export interface AggregateBucket {
  bucket_start: string;
  bucket_end: string;
  avg_value: number | null;
  min_value: number | null;
  max_value: number | null;
  count: number;
  unit: string;
  room: string;
  sensor_id: string;
  measurement: string;
  source: 'simulated' | 'measured' | null;
}

export interface AggregateResponse {
  room: string;
  sensor_id: string;
  measurement: string;
  interval: string;
  buckets: AggregateBucket[];
  total_count: number;
}

// Retention types
export interface RetentionStatus {
  enabled: boolean;
  raw_telemetry_days: number;
  cleanup_interval_hours: number;
  batch_size: number;
  dry_run: boolean;
  last_run: string | null;
  last_deleted_count: number;
  last_error: string | null;
}

// Simulator types
export interface SimulatorSensorConfig {
  room: string;
  sensor_id: string;
  type?: string;
  unit?: string;
  baseline: number;
  variation: number;
  min_value?: number;
  max_value?: number;
}

export interface SimulatorStatus {
  enabled: boolean;
  running: boolean;
  interval_seconds: number;
  seed: number;
  transport?: string;
  sensors: SimulatorSensorConfig[];
  current_temperatures: Record<string, number>;
  injections?: { sensor_id: string; kind: string; magnitude: number; until: string }[];
}

// Building layout types
export interface BuildingRoom {
  id: string;
  name: string;
  floor: number;
  position_x: number;
  position_y: number;
  position_z: number;
  size_x: number;
  size_y: number;
  size_z: number;
  sensor_id: string | null;
}

export interface BuildingFloor {
  level: number;
  name: string;
  height: number;
  rooms: BuildingRoom[];
}

export interface BuildingLayout {
  floors: BuildingFloor[];
  dimensions: {
    width: number;
    depth: number;
    floorHeight: number;
  };
}

// Detailed health
export interface DetailedHealthResponse {
  status: 'healthy' | 'degraded';
  version: string;
  database: string;
  mqtt: string;
  simulator: string;
  last_ingestion: string | null;
  latest_event_timestamp: string | null;
  last_retention_run: string | null;
  recent_errors: string[];
}

// Alert types
export type AlertType =
  | 'high_temperature'
  | 'critical_temperature'
  | 'low_temperature'
  | 'stale_sensor'
  | 'connectivity_loss'
  | 'invalid_reading';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface Alert {
  id: number;
  room: string;
  sensor_id: string;
  alert_type: AlertType;
  severity: AlertSeverity;
  title: string;
  description: string;
  status: AlertStatus;
  first_occurrence: string;
  last_occurrence: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  last_reading_value: number | null;
  threshold_value: number | null;
  occurrence_count: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface AlertListItem {
  id: number;
  room: string;
  sensor_id: string;
  alert_type: AlertType;
  severity: AlertSeverity;
  title: string;
  status: AlertStatus;
  first_occurrence: string;
  last_occurrence: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  last_reading_value: number | null;
  occurrence_count: number;
}

export interface AlertFilter {
  room?: string;
  sensor_id?: string;
  alert_type?: AlertType;
  severity?: AlertSeverity;
  status?: AlertStatus;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: string;
}

export interface AlertAcknowledgeRequest {
  actor?: string;
}

export interface AlertResolveRequest {
  actor?: string;
}

export interface AlertCountBySeverity {
  severity: AlertSeverity;
  count: number;
}

export interface AlertCountByStatus {
  status: AlertStatus;
  count: number;
}

export interface AlertCountsResponse {
  total: number;
  by_severity: AlertCountBySeverity[];
  by_status: AlertCountByStatus[];
}
