import type { Topology } from '../types/nexus';

// Scene geometry derived from the canonical topology. Units are metres; x/z in the topology
// are room centres on the floor plan, y is height above ground.

export const ROOM_HEIGHT = 3;
export const SLAB_THICKNESS = 0.2;

export interface RoomGeo {
  code: string;
  name: string;
  floor: number;
  center: [number, number, number];
  size: [number, number, number];
  sensorIds: string[];
}

export interface AssetGeo {
  code: string;
  kind: string;
  name: string;
  floor: number;
  position: [number, number, number];
  size: [number, number, number];
  sensorIds: string[];
}

export interface FloorGeo {
  level: number;
  name: string;
  elevation: number;
  height: number;
  slab: { center: [number, number, number]; size: [number, number, number] };
  rooms: RoomGeo[];
  assets: AssetGeo[];
}

export interface BuildingGeo {
  floors: FloorGeo[];
  width: number;
  depth: number;
  height: number;
  /** Centre of the whole building, used as the default camera target. */
  center: [number, number, number];
}

const ASSET_SIZE: Record<string, [number, number, number]> = {
  hvac: [2.4, 1.6, 1.6],
  meter: [0.9, 1.3, 0.9],
};

export function assetSize(kind: string): [number, number, number] {
  return ASSET_SIZE[kind] ?? [1, 1, 1];
}

export function buildGeometry(topology: Topology | null): BuildingGeo {
  if (!topology || topology.floors.length === 0) {
    return { floors: [], width: 20, depth: 15, height: 4, center: [10, 2, 7.5] };
  }

  let maxX = 0;
  let maxZ = 0;
  for (const f of topology.floors) {
    for (const r of f.rooms) {
      maxX = Math.max(maxX, r.x + r.width / 2);
      maxZ = Math.max(maxZ, r.z + r.depth / 2);
    }
    for (const a of f.assets) {
      const [w, , d] = assetSize(a.kind);
      maxX = Math.max(maxX, a.x + w / 2);
      maxZ = Math.max(maxZ, a.z + d / 2);
    }
  }
  const width = Math.ceil((maxX + 0.5) / 5) * 5;
  const depth = Math.ceil((maxZ + 0.5) / 5) * 5;

  const floors: FloorGeo[] = topology.floors.map(f => {
    const base = f.elevation_m + SLAB_THICKNESS;
    return {
      level: f.level,
      name: f.name,
      elevation: f.elevation_m,
      height: f.height_m,
      slab: {
        center: [width / 2, f.elevation_m + SLAB_THICKNESS / 2, depth / 2],
        size: [width, SLAB_THICKNESS, depth],
      },
      rooms: f.rooms.map(r => ({
        code: r.code,
        name: r.name,
        floor: f.level,
        center: [r.x, base + ROOM_HEIGHT / 2, r.z],
        size: [r.width, ROOM_HEIGHT, r.depth],
        sensorIds: r.sensors.map(s => s.sensor_id),
      })),
      assets: f.assets.map(a => {
        const size = assetSize(a.kind);
        return {
          code: a.code,
          kind: a.kind,
          name: a.name,
          floor: f.level,
          position: [a.x, base + size[1] / 2, a.z],
          size,
          sensorIds: a.sensors.map(s => s.sensor_id),
        };
      }),
    };
  });

  const top = Math.max(...floors.map(f => f.elevation + f.height));
  return { floors, width, depth, height: top, center: [width / 2, top / 2, depth / 2] };
}

/** Where a sensor's node sits in the scene (inside its room, or on top of its asset). */
export function sensorPositions(geo: BuildingGeo): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  for (const f of geo.floors) {
    for (const r of f.rooms) {
      r.sensorIds.forEach((id, i) =>
        out.set(id, [
          r.center[0] + (i - (r.sensorIds.length - 1) / 2) * 0.7,
          r.center[1] - 0.3,
          r.center[2],
        ])
      );
    }
    for (const a of f.assets) {
      a.sensorIds.forEach((id, i) =>
        out.set(id, [a.position[0] + i * 0.5, a.position[1] + a.size[1] / 2 + 0.4, a.position[2]])
      );
    }
  }
  return out;
}

/** Line-segment positions for the 12 edges of an axis-aligned box. */
export function boxEdges(c: [number, number, number], s: [number, number, number]): number[] {
  const [x0, y0, z0] = [c[0] - s[0] / 2, c[1] - s[1] / 2, c[2] - s[2] / 2];
  const [x1, y1, z1] = [c[0] + s[0] / 2, c[1] + s[1] / 2, c[2] + s[2] / 2];
  const v = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const pairs = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  return pairs.flatMap(([a, b]) => [...v[a], ...v[b]]);
}

export function floorWire(f: FloorGeo): Float32Array {
  const parts = [
    ...boxEdges(f.slab.center, f.slab.size),
    ...f.rooms.flatMap(r => boxEdges(r.center, r.size)),
    ...f.assets.flatMap(a => boxEdges(a.position, a.size)),
  ];
  return new Float32Array(parts);
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function webglSupported(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
