import { describe, expect, it } from 'vitest';
import type { Topology } from '../types/nexus';
import { boxEdges, buildGeometry, floorWire, ROOM_HEIGHT, sensorPositions } from './geometry';

const sensor = (id: string, type = 'temperature') => ({
  sensor_id: id,
  type,
  unit: 'celsius',
  source: 'simulated' as const,
  enabled: true,
  last_seen_at: null,
  location: null,
  floor: 0,
});

const topology: Topology = {
  building: { code: 'hq', name: 'HQ', timezone: 'UTC' },
  floors: [
    {
      level: 0,
      name: 'Ground',
      elevation_m: 0,
      height_m: 4,
      rooms: [
        {
          code: 'room101',
          name: 'Room 101',
          x: 2.5,
          z: 2.5,
          width: 5,
          depth: 5,
          sensors: [sensor('temp-sensor-101')],
        },
        {
          code: 'room102',
          name: 'Room 102',
          x: 12.5,
          z: 10,
          width: 5,
          depth: 5,
          sensors: [sensor('temp-sensor-102')],
        },
      ],
      assets: [
        {
          code: 'meter-f0',
          kind: 'meter',
          name: 'Meter',
          x: 18,
          z: 10,
          room: null,
          sensors: [sensor('power-meter-f0', 'power_kw')],
        },
      ],
    },
    { level: 1, name: 'One', elevation_m: 4, height_m: 4, rooms: [], assets: [] },
  ],
};

describe('buildGeometry', () => {
  it('has no floors and sane defaults before the topology loads', () => {
    const g = buildGeometry(null);
    expect(g.floors).toEqual([]);
    expect(g.width).toBeGreaterThan(0);
  });

  it('derives floors, rooms and assets from the topology', () => {
    const g = buildGeometry(topology);
    expect(g.floors.map(f => f.level)).toEqual([0, 1]);
    expect(g.floors[0].rooms.map(r => r.code)).toEqual(['room101', 'room102']);
    expect(g.floors[0].assets[0].sensorIds).toEqual(['power-meter-f0']);
  });

  it('places a room volume on top of its slab at the right elevation', () => {
    const g = buildGeometry(topology);
    const r = g.floors[0].rooms[0];
    expect(r.size).toEqual([5, ROOM_HEIGHT, 5]);
    expect(r.center[0]).toBe(2.5);
    expect(r.center[2]).toBe(2.5);
    expect(r.center[1] - ROOM_HEIGHT / 2).toBeCloseTo(0.2); // slab thickness
    expect(g.floors[1].slab.center[1]).toBeGreaterThan(g.floors[0].slab.center[1]);
  });

  it('sizes the footprint to contain every room and asset', () => {
    const g = buildGeometry(topology);
    expect(g.width).toBeGreaterThanOrEqual(18 + 0.45);
    expect(g.depth).toBeGreaterThanOrEqual(12.5);
    expect(g.center[0]).toBe(g.width / 2);
  });
});

describe('sensorPositions', () => {
  it('gives every topology sensor a position inside its owner', () => {
    const g = buildGeometry(topology);
    const p = sensorPositions(g);
    expect([...p.keys()].sort()).toEqual(['power-meter-f0', 'temp-sensor-101', 'temp-sensor-102']);
    const room = g.floors[0].rooms[0];
    const pos = p.get('temp-sensor-101')!;
    expect(Math.abs(pos[0] - room.center[0])).toBeLessThanOrEqual(room.size[0] / 2);
    expect(pos[1]).toBeLessThan(room.center[1] + room.size[1] / 2);
  });
});

describe('wireframes', () => {
  it('a box has 12 edges = 24 vertices = 72 numbers', () => {
    expect(boxEdges([0, 0, 0], [2, 2, 2])).toHaveLength(72);
  });
  it('a floor wire is the slab + rooms + assets', () => {
    const f = buildGeometry(topology).floors[0];
    expect(floorWire(f)).toHaveLength(72 * (1 + f.rooms.length + f.assets.length));
  });
});
