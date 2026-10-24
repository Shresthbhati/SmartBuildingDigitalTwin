import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react';
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Matrix4,
  Quaternion,
  Vector3,
  type InstancedMesh,
} from 'three';
import { useReducedMotion } from '../lib/useNow';
import { useNexus } from '../store';
import type { BuildingGeo } from './geometry';
import { DEFAULT_ANIM, type AnimRef, type SnapshotFn } from './sceneTypes';
import { SOURCE_STYLE, VISUAL_STATE_STYLE } from './state';
import type { IntroProgress } from './useIntro';

interface TelemetryRendererProps {
  geo: BuildingGeo;
  positions: Map<string, [number, number, number]>;
  anim: AnimRef;
  intro: MutableRefObject<IntroProgress>;
  snapshotFn: SnapshotFn;
  interactive: boolean;
}

const PULSE_SECONDS = 0.9;
const ZERO = new Vector3(0, 0, 0);

/**
 * Sensor nodes, drawn as three InstancedMeshes (node, provenance halo, pulse ring).
 *
 * Everything is derived from the store each frame: colour from the sensor's real status,
 * the halo from the reading's source, and a pulse fires only when the sensor's pulse counter
 * changes, i.e. when a new reading actually arrived. Nothing animates on a timer.
 */
export function TelemetryRenderer({
  geo,
  positions,
  anim,
  intro,
  snapshotFn,
  interactive,
}: TelemetryRendererProps) {
  const entries = useMemo(
    () =>
      geo.floors.flatMap(f =>
        [...f.rooms.flatMap(r => r.sensorIds), ...f.assets.flatMap(a => a.sensorIds)]
          .map(id => ({ id, floor: f.level, pos: positions.get(id) }))
          .filter((e): e is { id: string; floor: number; pos: [number, number, number] } => !!e.pos)
      ),
    [geo, positions]
  );

  const nodes = useRef<InstancedMesh>(null);
  const halos = useRef<InstancedMesh>(null);
  const pulses = useRef<InstancedMesh>(null);
  const lastPulse = useRef<(number | undefined)[]>([]);
  const pulseT = useRef<number[]>([]);
  const reduced = useRef(false);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    reduced.current = reducedMotion;
  }, [reducedMotion]);

  const scratch = useMemo(
    () => ({
      m: new Matrix4(),
      q: new Quaternion(),
      p: new Vector3(),
      s: new Vector3(),
      c: new Color(),
    }),
    []
  );

  // Allocate the per-instance colour buffers up front.
  useLayoutEffect(() => {
    for (const mesh of [nodes.current, halos.current, pulses.current]) {
      if (!mesh) continue;
      entries.forEach((_, i) => mesh.setColorAt(i, scratch.c.set('#ffffff')));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    lastPulse.current = [];
    pulseT.current = [];
  }, [entries, scratch]);

  useFrame(({ camera }, dt) => {
    const n = nodes.current;
    const h = halos.current;
    const p = pulses.current;
    if (!n || !h || !p) return;
    const { m, q, p: pos, s, c } = scratch;
    const st = useNexus.getState();
    const now = Date.now();
    const live = st.cursor === 'live';

    entries.forEach((e, i) => {
      const a = anim.current.get(e.floor) ?? DEFAULT_ANIM;
      const snap = snapshotFn(st, e.id, now);
      const style = VISUAL_STATE_STYLE[snap.visual];
      const selected = st.selection.sensor === e.id;
      const grow = intro.current.sensors;
      const dim = 0.35 + 0.65 * a.opacity;
      pos.set(e.pos[0], e.pos[1] + a.dy, e.pos[2]);

      // node
      q.identity();
      s.setScalar(Math.max(0.0001, grow * (selected ? 1.55 : 1) * (a.opacity < 0.2 ? 0.5 : 1)));
      m.compose(pos, q, s);
      n.setMatrixAt(i, m);
      n.setColorAt(i, c.set(style.color).multiplyScalar(dim));

      // provenance halo: facing the camera, only for non-measured data
      const src = snap.source;
      q.copy(camera.quaternion);
      const haloScale =
        src === null || src === 'measured' ? 0.0001 : grow * (src === 'scenario' ? 1.5 : 1.15);
      s.setScalar(haloScale);
      m.compose(pos, q, s);
      h.setMatrixAt(i, m);
      h.setColorAt(i, c.set(src ? SOURCE_STYLE[src].color : '#000000').multiplyScalar(dim));

      // pulse: restart only when the sensor's reading counter moved
      if (live) {
        const count = st.pulses[e.id] ?? 0;
        const seen = lastPulse.current[i];
        if (seen !== undefined && count !== seen && !reduced.current) pulseT.current[i] = 0;
        lastPulse.current[i] = count;
      }
      const t = pulseT.current[i];
      if (t !== undefined && t < PULSE_SECONDS) {
        const k = t / PULSE_SECONDS;
        pulseT.current[i] = t + dt;
        s.setScalar(grow * (1 + k * 3.4));
        m.compose(pos, q, s);
        p.setMatrixAt(i, m);
        p.setColorAt(i, c.set(style.color).multiplyScalar((1 - k) * a.opacity));
      } else {
        m.compose(ZERO, q, s.setScalar(0.0001));
        p.setMatrixAt(i, m);
      }
    });

    for (const mesh of [n, h, p]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  });

  if (entries.length === 0) return null;

  return (
    <>
      <instancedMesh
        ref={nodes}
        args={[undefined, undefined, entries.length]}
        raycast={interactive ? undefined : () => null}
        onClick={
          interactive
            ? e => {
                const entry = entries[e.instanceId ?? -1];
                if (!entry || (anim.current.get(entry.floor)?.opacity ?? 1) < 0.5) return;
                e.stopPropagation();
                const room = geo.floors
                  .flatMap(f => f.rooms)
                  .find(r => r.sensorIds.includes(entry.id));
                useNexus.getState().select({
                  sensor: entry.id,
                  room: room?.code ?? null,
                  anomalyId: null,
                  alertId: null,
                });
              }
            : undefined
        }
      >
        <sphereGeometry args={[0.26, 20, 20]} />
        <meshStandardMaterial emissiveIntensity={0.9} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={halos} args={[undefined, undefined, entries.length]} raycast={() => null}>
        <ringGeometry args={[0.36, 0.41, 32]} />
        <meshBasicMaterial
          transparent
          opacity={0.9}
          depthWrite={false}
          side={DoubleSide}
          toneMapped={false}
        />
      </instancedMesh>
      <instancedMesh
        ref={pulses}
        args={[undefined, undefined, entries.length]}
        raycast={() => null}
      >
        <ringGeometry args={[0.3, 0.36, 40]} />
        <meshBasicMaterial
          transparent
          depthWrite={false}
          side={DoubleSide}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </instancedMesh>
    </>
  );
}
