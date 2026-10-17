import type { SensorReading, AggregateBucket } from '../types';

export interface RoomTelemetryState {
  roomId: string;
  roomName: string;
  floor: number;
  sensorId: string | undefined;
  currentTemperature: number | null;
  status: 'NORMAL' | 'HIGH' | 'ALERT' | 'UNKNOWN';
  lastUpdated: string | null;
  source: 'simulated' | 'measured' | null;
  isStale: boolean;
  history: SensorReading[];
  aggregate: AggregateBucket[];
  loading: boolean;
  error: string | null;
}

export interface BuildingTelemetryState {
  rooms: Map<string, RoomTelemetryState>;
  selectedRoomId: string | null;
  hoveredRoomId: string | null;
  activeFloor: number;
  isLoading: boolean;
  globalError: string | null;
}

export interface ViewportState {
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  zoom: number;
}

export type RoomVisualState =
  'normal' | 'warning' | 'critical' | 'stale' | 'unknown' | 'selected' | 'hovered';

export function getRoomVisualState(room: RoomTelemetryState): RoomVisualState {
  if (room.status === 'ALERT') return 'critical';
  if (room.status === 'HIGH') return 'warning';
  if (room.status === 'UNKNOWN' || room.currentTemperature === null) return 'unknown';
  if (room.isStale) return 'stale';
  return 'normal';
}

export const VISUAL_STATE_COLORS: Record<RoomVisualState, string> = {
  normal: '#4ade80',
  warning: '#fbbf24',
  critical: '#ef4444',
  stale: '#64748b',
  unknown: '#3b82f6',
  selected: '#a855f7',
  hovered: '#f97316',
};

export const ROOM_OPACITY: Record<RoomVisualState, number> = {
  normal: 0.8,
  warning: 0.85,
  critical: 0.9,
  stale: 0.5,
  unknown: 0.4,
  selected: 1.0,
  hovered: 0.95,
};
