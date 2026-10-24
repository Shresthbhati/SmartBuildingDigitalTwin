import { describe, expect, it } from 'vitest';
import { parseDeepLink, serializeDeepLink } from './deeplink';

describe('deep links', () => {
  it('parses floor, room, sensor and t', () => {
    const l = parseDeepLink(
      '?floor=1&room=room204&sensor=temp-sensor-204&t=2026-03-02T12:00:00.000Z'
    );
    expect(l).toEqual({
      floor: 1,
      room: 'room204',
      sensor: 'temp-sensor-204',
      t: Date.parse('2026-03-02T12:00:00Z'),
    });
  });

  it('defaults to live with nothing selected', () => {
    expect(parseDeepLink('')).toEqual({ floor: null, room: null, sensor: null, t: 'live' });
    expect(parseDeepLink('?t=live').t).toBe('live');
  });

  it('rejects malformed values instead of guessing', () => {
    const l = parseDeepLink('?floor=abc&t=yesterday');
    expect(l.floor).toBeNull();
    expect(l.t).toBe('live');
  });

  it('accepts floor 0 and negative floors', () => {
    expect(parseDeepLink('?floor=0').floor).toBe(0);
    expect(parseDeepLink('?floor=-1').floor).toBe(-1);
  });

  it('round-trips', () => {
    const link = { floor: 0, room: 'room101', sensor: null, t: Date.parse('2026-03-02T12:00:00Z') };
    expect(parseDeepLink(serializeDeepLink(link))).toEqual(link);
  });

  it('serialises a live, empty selection to nothing', () => {
    expect(serializeDeepLink({ floor: null, room: null, sensor: null, t: 'live' })).toBe('');
  });
});
