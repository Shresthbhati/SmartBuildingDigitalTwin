import type { MutableRefObject } from 'react';
import type { NexusState } from '../store';
import type { SensorSnapshot } from '../store/selectors';

/** How a scene turns a sensor id into what to draw. Default is live/time-travel from the store. */
export type SnapshotFn = (state: NexusState, sensorId: string, nowMs: number) => SensorSnapshot;

/** Per-floor animated values shared by the floor groups and the telemetry layer. */
export interface FloorAnim {
  /** Vertical offset while the floors are descending during the intro. */
  dy: number;
  /** 1 = fully visible; low when another floor is isolated. */
  opacity: number;
}

export type AnimRef = MutableRefObject<Map<number, FloorAnim>>;

export const DEFAULT_ANIM: FloorAnim = { dy: 0, opacity: 1 };
export const DIMMED_OPACITY = 0.07;
