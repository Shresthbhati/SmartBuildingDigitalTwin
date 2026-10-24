import type { ReadingSourceName } from '../types/nexus';

/**
 * How a sensor reading maps to what the user sees. Every visual state is derived from a
 * persisted reading (value + its real event timestamp + source); nothing is decorative.
 *
 * Status is never colour alone: each state has an icon and a label that accompany the colour
 * everywhere it appears (legend, tooltips, inspector, accessible list).
 */
export type VisualState = 'normal' | 'warning' | 'critical' | 'stale' | 'offline';

export interface VisualStyle {
  color: string;
  label: string;
  icon: string;
  description: string;
}

export const VISUAL_STATE_STYLE: Record<VisualState, VisualStyle> = {
  normal: { color: '#22d3ee', label: 'Normal', icon: '●', description: 'Reporting, within limits' },
  warning: {
    color: '#fbbf24',
    label: 'Warning',
    icon: '▲',
    description: 'Above the warning threshold',
  },
  critical: {
    color: '#f87171',
    label: 'Critical',
    icon: '◆',
    description: 'Above the critical threshold',
  },
  stale: { color: '#7b8494', label: 'Stale', icon: '◔', description: 'No recent reading' },
  offline: { color: '#4b5563', label: 'No data', icon: '○', description: 'Never reported' },
};

/** Worst-first ordering, used to summarise several sensors (a room) as one state. */
const SEVERITY_RANK: Record<VisualState, number> = {
  critical: 4,
  warning: 3,
  stale: 2,
  offline: 1,
  normal: 0,
};

export function worstState(states: VisualState[]): VisualState {
  return states.reduce<VisualState>(
    (worst, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst),
    'normal'
  );
}

export interface Thresholds {
  warning: number;
  critical: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { warning: 30, critical: 35 };
export const DEFAULT_STALE_AFTER_MS = 120_000;

export interface StateInput {
  value: number | null;
  type: string;
  /** Event time of the reading, or null if the sensor has never reported. */
  timestampMs: number | null;
  nowMs: number;
  staleAfterMs: number;
  thresholds: Thresholds;
}

export function sensorVisualState(i: StateInput): VisualState {
  if (i.timestampMs === null) return 'offline';
  if (i.nowMs - i.timestampMs > i.staleAfterMs) return 'stale';
  if (i.value === null) return 'offline';
  // Thresholds are temperature limits; other measurements have none, so they read as normal.
  if (i.type === 'temperature') {
    if (i.value > i.thresholds.critical) return 'critical';
    if (i.value > i.thresholds.warning) return 'warning';
  }
  return 'normal';
}

export interface SourceStyle {
  color: string;
  label: string;
  short: string;
}

/** Data provenance. Violet is reserved for anything that is not a real measurement. */
export const SOURCE_STYLE: Record<ReadingSourceName, SourceStyle> = {
  measured: { color: '#22d3ee', label: 'Measured', short: 'MEAS' },
  simulated: { color: '#a78bfa', label: 'Simulated', short: 'SIM' },
  scenario: { color: '#c084fc', label: 'Scenario-injected', short: 'SCEN' },
};

/** Colours for non-status scene elements. */
export const SCENE_COLORS = {
  background: '#0b0e13',
  wire: '#2b3445',
  floor: '#141a24',
  anomaly: '#fbbf24',
  selected: '#e2e8f0',
  hover: '#67e8f9',
  energy: '#a78bfa',
};
