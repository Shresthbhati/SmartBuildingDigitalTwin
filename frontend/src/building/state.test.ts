import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  SOURCE_STYLE,
  VISUAL_STATE_STYLE,
  sensorVisualState,
  worstState,
  type StateInput,
} from './state';

const NOW = 1_000_000;
const base: StateInput = {
  value: 22,
  type: 'temperature',
  timestampMs: NOW - 5_000,
  nowMs: NOW,
  staleAfterMs: 120_000,
  thresholds: DEFAULT_THRESHOLDS,
};

describe('sensorVisualState', () => {
  it('maps value bands to normal / warning / critical (strictly above the limits)', () => {
    expect(sensorVisualState(base)).toBe('normal');
    expect(sensorVisualState({ ...base, value: 30 })).toBe('normal');
    expect(sensorVisualState({ ...base, value: 30.1 })).toBe('warning');
    expect(sensorVisualState({ ...base, value: 35 })).toBe('warning');
    expect(sensorVisualState({ ...base, value: 35.1 })).toBe('critical');
  });

  it('a sensor that never reported is offline, not normal', () => {
    expect(sensorVisualState({ ...base, timestampMs: null, value: null })).toBe('offline');
  });

  it('an old reading is stale even if its value is alarming: it is not current', () => {
    expect(sensorVisualState({ ...base, value: 40, timestampMs: NOW - 121_000 })).toBe('stale');
    expect(sensorVisualState({ ...base, value: 40, timestampMs: NOW - 120_000 })).toBe('critical');
  });

  it('missing value with a timestamp is offline', () => {
    expect(sensorVisualState({ ...base, value: null })).toBe('offline');
  });

  it('temperature thresholds do not apply to other measurements', () => {
    expect(sensorVisualState({ ...base, type: 'power_kw', value: 90 })).toBe('normal');
  });
});

describe('worstState', () => {
  it('orders critical > warning > stale > offline > normal', () => {
    expect(worstState(['normal', 'warning', 'critical'])).toBe('critical');
    expect(worstState(['normal', 'stale', 'offline'])).toBe('stale');
    expect(worstState(['normal', 'offline'])).toBe('offline');
    expect(worstState(['normal'])).toBe('normal');
    expect(worstState([])).toBe('normal');
  });
});

describe('status is never colour alone', () => {
  it('every state has a distinct icon and a label', () => {
    const icons = Object.values(VISUAL_STATE_STYLE).map(s => s.icon);
    expect(new Set(icons).size).toBe(icons.length);
    for (const s of Object.values(VISUAL_STATE_STYLE)) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it('simulated and scenario data are both violet-family and clearly labelled', () => {
    expect(SOURCE_STYLE.simulated.label).toBe('Simulated');
    expect(SOURCE_STYLE.scenario.label).toBe('Scenario-injected');
    expect(SOURCE_STYLE.measured.label).toBe('Measured');
  });
});
