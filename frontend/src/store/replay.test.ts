import { describe, expect, it } from 'vitest';
import type { ReplayEntity, ReplayPoint } from '../types/nexus';
import { activeAt, lastIndexAtOrBefore, stateAt, statusAt } from './replay';

const T0 = Date.parse('2026-03-02T12:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const pt = (sec: number, v: number): ReplayPoint => ({ t: at(sec), v, n: 1 });

// One reading a minute for 3 minutes, then a 10-minute outage, then two more.
const points = [pt(0, 22.0), pt(60, 22.4), pt(120, 22.8), pt(720, 24.0), pt(780, 24.2)];

describe('stateAt: the building as it was at T', () => {
  it('uses the last reading at or before T', () => {
    const s = stateAt(points, T0 + 90_000, 120);
    expect(s.kind).toBe('value');
    if (s.kind === 'value') expect(s.point.v).toBe(22.4);
  });

  it('includes a reading exactly at T', () => {
    const s = stateAt(points, T0 + 120_000, 120);
    expect(s.kind === 'value' && s.point.v).toBe(22.8);
  });

  it('never looks ahead of T, even if a later reading exists', () => {
    const s = stateAt(points, T0 + 119_000, 120);
    expect(s.kind === 'value' && s.point.v).toBe(22.4);
  });

  it('reports a gap when the last reading is older than stale_after', () => {
    const s = stateAt(points, T0 + 400_000, 120); // 280 s after the last reading
    expect(s.kind).toBe('gap');
    if (s.kind === 'gap') {
      expect(s.lastPoint?.v).toBe(22.8);
      expect(s.ageSeconds).toBe(280);
    }
  });

  it('is still a value right at the stale boundary', () => {
    expect(stateAt(points, T0 + 120_000 + 120_000, 120).kind).toBe('value');
    expect(stateAt(points, T0 + 120_000 + 121_000, 120).kind).toBe('gap');
  });

  it('has no data before the first reading and for empty series', () => {
    expect(stateAt(points, T0 - 1000, 120).kind).toBe('no-data');
    expect(stateAt([], T0, 120).kind).toBe('no-data');
  });

  it('recovers after the outage', () => {
    const s = stateAt(points, T0 + 730_000, 120);
    expect(s.kind === 'value' && s.point.v).toBe(24.0);
  });
});

describe('lastIndexAtOrBefore', () => {
  it('binary searches correctly at the edges', () => {
    expect(lastIndexAtOrBefore(points, T0 - 1)).toBe(-1);
    expect(lastIndexAtOrBefore(points, T0)).toBe(0);
    expect(lastIndexAtOrBefore(points, T0 + 5_000_000)).toBe(points.length - 1);
  });
});

const entity = (over: Partial<ReplayEntity>): ReplayEntity => ({
  id: 1,
  room: 'room101',
  sensor_id: 'temp-sensor-101',
  type: 'high_temperature',
  severity: 'WARNING',
  status: 'RESOLVED',
  title: 't',
  started_at: at(100),
  acknowledged_at: at(200),
  resolved_at: at(300),
  ...over,
});

describe('statusAt: lifecycle status at T', () => {
  const e = entity({});
  it('did not exist before it started', () => expect(statusAt(e, T0 + 99_000)).toBeNull());
  it('is open from its start', () => expect(statusAt(e, T0 + 100_000)).toBe('OPEN'));
  it('is acknowledged after acknowledgement', () =>
    expect(statusAt(e, T0 + 250_000)).toBe('ACKNOWLEDGED'));
  it('is resolved after resolution', () => expect(statusAt(e, T0 + 300_000)).toBe('RESOLVED'));
  it('skips acknowledgement when there was none', () => {
    expect(statusAt(entity({ acknowledged_at: null }), T0 + 250_000)).toBe('OPEN');
  });
  it('stays open when never resolved', () => {
    expect(statusAt(entity({ resolved_at: null, acknowledged_at: null }), T0 + 9_999_000)).toBe(
      'OPEN'
    );
  });
});

describe('activeAt', () => {
  it('lists only items open or acknowledged at T', () => {
    const list = [
      entity({ id: 1 }),
      entity({ id: 2, started_at: at(500), acknowledged_at: null, resolved_at: null }),
    ];
    expect(activeAt(list, T0 + 50_000).map(e => e.id)).toEqual([]);
    expect(activeAt(list, T0 + 150_000).map(e => e.id)).toEqual([1]);
    expect(activeAt(list, T0 + 350_000).map(e => e.id)).toEqual([]);
    expect(activeAt(list, T0 + 600_000).map(e => e.id)).toEqual([2]);
  });
});
