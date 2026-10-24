// Types for the NEXUS backend contracts (topology, replay, investigation, scenarios,
// anticipate, realtime). They mirror the JSON the FastAPI services return.

export type ReadingSourceName = 'simulated' | 'measured' | 'scenario';
export type Role = 'viewer' | 'operator' | 'admin';

// --------------------------------------------------------------------- topology
export interface SensorInfo {
  sensor_id: string;
  type: string; // 'temperature' | 'power_kw' | ...
  unit: string;
  source: 'simulated' | 'measured';
  enabled: boolean;
  last_seen_at: string | null;
  location: string | null; // room code, or asset code for meters
  floor: number | null;
}

export interface TopologyRoom {
  code: string;
  name: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  sensors: SensorInfo[];
}

export interface TopologyAsset {
  code: string;
  kind: string; // 'hvac' | 'meter' | ...
  name: string;
  x: number;
  z: number;
  room: string | null;
  sensors: SensorInfo[];
}

export interface TopologyFloor {
  level: number;
  name: string;
  elevation_m: number;
  height_m: number;
  rooms: TopologyRoom[];
  assets: TopologyAsset[];
}

export interface Topology {
  building: { code: string; name: string; timezone: string } | null;
  floors: TopologyFloor[];
}

export interface LatestReading {
  sensor_id: string;
  room: string;
  measurement: string;
  value: number;
  unit: string;
  source: ReadingSourceName;
  event_timestamp: string;
}

export interface Meta {
  auth_enabled: boolean;
  stale_after_seconds: number;
  retention_days: number;
  simulator: {
    enabled: boolean;
    interval_seconds: number;
    transport: string;
    injection_kinds: string[];
  };
  thresholds: { warning: number; critical: number; recovery: number };
  anomaly_detection: {
    z_score_threshold: number;
    spike_threshold: number;
    rolling_window_size: number;
  };
  scenario_bounds: {
    max_window_minutes: number;
    step_seconds: number;
    baseline_offset: [number, number];
    variation_scale: [number, number];
    power_setpoint_kw: [number, number];
  };
  replay: { max_points_per_sensor: number; event_limit: number };
}

// --------------------------------------------------------------------- anomalies
export type AnomalyCategory = 'z_score_spike' | 'z_score_drop' | 'sustained_deviation';
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
export type LifecycleStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface AnomalyListItem {
  id: number;
  room: string;
  sensor_id: string;
  anomaly_category: AnomalyCategory;
  severity: Severity;
  title: string;
  status: LifecycleStatus;
  detected_at: string;
  last_observed_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  observed_value: number;
  expected_baseline: number;
  deviation_score: number;
  occurrence_count: number;
}

export interface Anomaly extends AnomalyListItem {
  description: string;
  acknowledged_by: string | null;
  metadata: AnomalyMetadata | null;
  created_at: string;
  updated_at: string;
}

export interface AnomalyMetadata {
  detection_method?: string;
  z_score?: number;
  rolling_mean?: number;
  rolling_stddev?: number;
  sample_count?: number;
  window_size?: number;
  threshold_used?: number;
  detector_config?: {
    z_score_threshold: number;
    spike_threshold: number;
    drop_threshold: number;
    min_samples: number;
    cooldown_seconds: number;
  };
  unit?: string;
  source?: ReadingSourceName;
}

// --------------------------------------------------------------------- context graph
export interface GraphNode {
  id: string;
  kind: 'anomaly' | 'alert' | 'sensor' | 'room' | 'floor' | 'asset';
  label: string;
  status?: LifecycleStatus;
  severity?: Severity;
  at?: string;
  focus?: boolean;
  sibling?: boolean;
  sensor_id?: string;
  room?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'structural' | 'temporal_cooccurrence';
  label: string;
  delta_seconds?: number;
  same_sensor?: boolean;
}

export interface AnomalyContext {
  anomaly_id: number;
  window_minutes: number;
  detected_at: string;
  sensor: SensorInfo | null;
  location: {
    room: { code: string; name: string } | null;
    asset: { code: string; kind: string; name: string } | null;
    floor: { level: number; name: string };
  } | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: {
    readings: { t: string; v: number; source: ReadingSourceName }[];
    baseline: {
      mean: number;
      stddev: number;
      lower: number;
      upper: number;
      z_threshold: number;
      sample_count?: number;
      window_size?: number;
    } | null;
    observed_value: number;
    deviation_score: number;
    detector_config?: AnomalyMetadata['detector_config'];
  };
  disclaimer: string;
}

// --------------------------------------------------------------------- replay
export interface ReplayPoint {
  t: string;
  v: number;
  n: number;
  lo?: number;
  hi?: number;
  s?: ReadingSourceName; // present only for non-simulated readings
}

export interface ReplaySensor {
  sensor_id: string;
  location: string | null;
  type: string;
  unit: string;
  source: string;
  floor: number | null;
  resolution: 'raw' | 'aggregated';
  sample_count: number;
  points: ReplayPoint[];
}

export interface ReplayEntity {
  id: number;
  room: string;
  sensor_id: string;
  type: string;
  severity: Severity;
  status: LifecycleStatus;
  title: string;
  started_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

export interface ReplayEvent {
  at: string;
  entity_type: 'alert' | 'anomaly';
  entity_id: number;
  from: string | null;
  to: string;
  actor: string | null;
  room: string;
  sensor_id: string;
  severity: Severity;
  title: string;
  source: 'audit' | 'derived';
}

export interface ReplayResponse {
  start: string;
  end: string;
  requested_start: string;
  clamped_to_retention: boolean;
  retention_days: number;
  retention_floor: string;
  floor: number | null;
  max_points: number;
  bucket_seconds: number;
  stale_after_seconds: number;
  sensors: ReplaySensor[];
  alerts: ReplayEntity[];
  anomalies: ReplayEntity[];
  events: ReplayEvent[];
  event_total: number;
  event_offset: number;
  event_limit: number;
  truncated: boolean;
}

// --------------------------------------------------------------------- scenarios
export interface ScenarioRequest {
  sensor_id?: string | null;
  floor?: number | null;
  baseline_offset: number;
  variation_scale: number;
  power_setpoint_kw?: number | null;
  window_minutes: number;
  label?: string | null;
  save?: boolean;
}

export interface ScenarioSeriesPoint {
  t: string;
  v: number;
}

export interface ScenarioResult {
  sensor_id: string;
  location: string | null;
  type: string;
  unit: string;
  baseline: ScenarioSeriesPoint[];
  scenario: ScenarioSeriesPoint[];
  delta: {
    mean: number;
    min: number;
    max: number;
    max_abs: number;
    baseline_mean: number;
    scenario_mean: number;
  };
  clamped_steps: { baseline: number; scenario: number };
  applied: {
    baseline: number;
    variation: number;
    configured_baseline: number;
    configured_variation: number;
  };
}

export interface ScenarioResponse {
  mode: 'scenario';
  advisory: string;
  label: string | null;
  target: { sensor_id: string | null; floor: number | null };
  assumptions: {
    model: string;
    seed: number;
    rng: string;
    step_seconds: number;
    steps: number;
    window_minutes: number;
    start: string;
    timezone: string;
    parameters: {
      baseline_offset: number;
      variation_scale: number;
      power_setpoint_kw: number | null;
    };
    notes: string[];
  };
  results: ScenarioResult[];
  saved_run_id: number | null;
}

export interface InjectRequest {
  sensor_id: string;
  kind: 'spike' | 'drift' | 'offline';
  duration_seconds: number;
  magnitude?: number | null;
}

// --------------------------------------------------------------------- anticipate
export interface EvidenceLink {
  kind: 'alert' | 'anomaly';
  id: number;
}

export interface MaintenanceFlag {
  sensor_id: string;
  location: string | null;
  asset: string | null;
  rule: string;
  severity: 'watch' | 'attention';
  summary: string;
  evidence: Record<string, unknown>;
  evidence_links: EvidenceLink[];
  basis: string;
}

export interface MaintenanceResponse {
  basis: string;
  disclaimer: string;
  generated_at: string;
  lookback_days: number;
  flags: MaintenanceFlag[];
}

export interface ForecastPoint {
  t: string;
  v: number;
  lo: number;
  hi: number;
}

export interface ForecastResponse {
  sensor_id: string;
  label: 'estimated';
  method: string;
  horizon_minutes: number;
  unit: string;
  stale_after_seconds: number;
  generated_at: string;
  abstained: boolean;
  reason: 'sparse' | 'stale' | null;
  detail?: string;
  based_on?: { n: number; from: string; to: string };
  slope_per_hour?: number;
  residual_std?: number;
  points: ForecastPoint[];
}

export interface EnergyMeter {
  sensor_id: string;
  location: string | null;
  floor: number | null;
  source: string;
  label: 'simulated' | 'measured';
  kwh: number;
  avg_kw: number | null;
  peak_kw: number | null;
  peak_at: string | null;
  coverage: number;
  series: { t: string; kw: number }[];
}

export interface EnergyResponse {
  start: string;
  end: string;
  bucket_seconds: number;
  note: string;
  meters: EnergyMeter[];
  total_kwh: number;
  peak_kw_total: number;
}

// --------------------------------------------------------------------- realtime
export type StreamType = 'reading' | 'alert' | 'anomaly' | 'health';

export interface ReadingEventData {
  sensor_id: string;
  room: string;
  measurement: string;
  value: number;
  unit: string;
  source: ReadingSourceName;
  event_timestamp: string;
  room_status: 'NORMAL' | 'HIGH' | 'ALERT' | null;
}

export interface LifecycleEventData {
  event: 'created' | 'acknowledged' | 'resolved';
  id: number;
  room: string;
  sensor_id: string;
  severity: Severity;
  status: LifecycleStatus;
  title: string;
  actor: string | null;
  at: string;
  alert_type?: string;
  anomaly_category?: AnomalyCategory;
}

export interface HealthEventData {
  mqtt: string;
  simulator: string;
  ws_clients: number;
  hello?: boolean;
}

export type StreamEnvelope =
  | { seq: number; type: 'reading'; ts: string | null; data: ReadingEventData }
  | { seq: number; type: 'alert'; ts: string | null; data: LifecycleEventData }
  | { seq: number; type: 'anomaly'; ts: string | null; data: LifecycleEventData }
  | { seq: number; type: 'health'; ts: string | null; data: HealthEventData };

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface AuthSession {
  username: string;
  role: Role;
  token: string;
  expiresAt: number; // epoch ms
}
