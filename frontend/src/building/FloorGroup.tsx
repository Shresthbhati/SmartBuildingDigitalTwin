import { Edges, Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import gsap from 'gsap';
import { useEffect, useLayoutEffect, useMemo, useRef, type ComponentRef } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Matrix4,
  Quaternion,
  Vector3,
  type Group,
  type InstancedMesh,
  type LineBasicMaterial,
  type Mesh,
  type MeshBasicMaterial,
  type MeshStandardMaterial,
} from 'three';
import { useReducedMotion } from '../lib/useNow';
import { useNexus } from '../store';
import type { NexusState } from '../store';
import type { ActiveEntities } from '../store/selectors';
import { DEFAULT_ANIM, type AnimRef, type SnapshotFn } from './sceneTypes';
import { floorWire, type AssetGeo, type FloorGeo, type RoomGeo } from './geometry';
import type { IntroProgress } from './useIntro';
import { SCENE_COLORS, VISUAL_STATE_STYLE, worstState, type VisualState } from './state';

interface FloorGroupProps {
  floor: FloorGeo;
  anim: AnimRef;
  intro: React.MutableRefObject<IntroProgress>;
  active: ActiveEntities;
  snapshotFn: SnapshotFn;
  hoveredRoom: string | null;
  onHover: (room: string | null) => void;
  interactive: boolean;
  showEnergy: boolean;
}

/** Worst visual state across a room's sensors, plus the headline reading for its label. */
function summarize(state: NexusState, ids: string[], snapshotFn: SnapshotFn, now: number) {
  const snaps = ids.map(id => snapshotFn(state, id, now));
  const primary = snaps.find(s => s.type === 'temperature') ?? snaps[0];
  return {
    visual: (snaps.length ? worstState(snaps.map(s => s.visual)) : 'offline') as VisualState,
    value: primary?.value ?? null,
    lastValue: primary?.lastValue ?? null,
    unit: primary?.unit ?? '',
    timestampMs: primary?.timestampMs ?? null,
    source: primary?.source ?? null,
    gap: primary?.gap ?? false,
    sensorId: primary?.sensorId ?? null,
  };
}

export function FloorGroup({
  floor,
  anim,
  intro,
  active,
  snapshotFn,
  hoveredRoom,
  onHover,
  interactive,
  showEnergy,
}: FloorGroupProps) {
  const group = useRef<Group>(null);
  const slabMat = useRef<MeshStandardMaterial>(null);
  const wireMat = useRef<LineBasicMaterial>(null);

  const wireGeometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(floorWire(floor), 3));
    return g;
  }, [floor]);
  useEffect(() => () => wireGeometry.dispose(), [wireGeometry]);

  useFrame(() => {
    const a = anim.current.get(floor.level) ?? DEFAULT_ANIM;
    if (group.current) group.current.position.y = a.dy;
    wireGeometry.setDrawRange(
      0,
      Math.floor(wireGeometry.getAttribute('position').count * intro.current.wire)
    );
    if (wireMat.current) wireMat.current.opacity = 0.85 * a.opacity;
    if (slabMat.current) slabMat.current.opacity = 0.55 * a.opacity;
  });

  return (
    <group ref={group}>
      <mesh position={floor.slab.center} receiveShadow>
        <boxGeometry args={floor.slab.size} />
        <meshStandardMaterial
          ref={slabMat}
          color={SCENE_COLORS.floor}
          transparent
          opacity={0.55}
          roughness={0.9}
        />
      </mesh>
      <lineSegments geometry={wireGeometry}>
        <lineBasicMaterial ref={wireMat} color={SCENE_COLORS.wire} transparent opacity={0.85} />
      </lineSegments>

      {floor.rooms.map(room => (
        <RoomVolume
          key={room.code}
          room={room}
          anim={anim}
          active={active}
          snapshotFn={snapshotFn}
          hovered={hoveredRoom === room.code}
          onHover={onHover}
          interactive={interactive}
        />
      ))}

      <AssetLayer floor={floor} anim={anim} snapshotFn={snapshotFn} interactive={interactive} />
      {showEnergy && <FloorEnergy floor={floor} snapshotFn={snapshotFn} anim={anim} />}
    </group>
  );
}

// ---------------------------------------------------------------------------------------- rooms
interface RoomVolumeProps {
  room: RoomGeo;
  anim: AnimRef;
  active: ActiveEntities;
  snapshotFn: SnapshotFn;
  hovered: boolean;
  onHover: (room: string | null) => void;
  interactive: boolean;
}

function RoomVolume({
  room,
  anim,
  active,
  snapshotFn,
  hovered,
  onHover,
  interactive,
}: RoomVolumeProps) {
  const mesh = useRef<Mesh>(null);
  const mat = useRef<MeshStandardMaterial>(null);
  const shown = useRef<VisualState | null>(null);
  const selected = useNexus(s => s.selection.room === room.code);
  const anomalyIds = active.anomaliesByRoom.get(room.code) ?? [];
  const hasAnomaly = anomalyIds.length > 0;

  useFrame(() => {
    const a = anim.current.get(room.floor) ?? DEFAULT_ANIM;
    const m = mat.current;
    if (!m || !mesh.current) return;
    const { visual } = summarize(useNexus.getState(), room.sensorIds, snapshotFn, Date.now());
    if (shown.current !== visual) {
      shown.current = visual;
      m.color.set(VISUAL_STATE_STYLE[visual].color);
      m.emissive.set(VISUAL_STATE_STYLE[visual].color);
    }
    const base = selected ? 0.34 : hovered ? 0.26 : 0.15;
    m.opacity = base * a.opacity;
    m.emissiveIntensity = selected ? 0.5 : 0.2;
    // Rooms on a dimmed floor can't be picked.
    mesh.current.visible = a.opacity > 0.02;
  });

  const canPick = interactive;
  return (
    <group>
      <mesh
        ref={mesh}
        position={room.center}
        raycast={canPick ? undefined : () => null}
        onClick={
          canPick
            ? e => {
                if ((anim.current.get(room.floor)?.opacity ?? 1) < 0.5) return;
                e.stopPropagation();
                useNexus
                  .getState()
                  .select({ room: room.code, sensor: null, anomalyId: null, alertId: null });
              }
            : undefined
        }
        onPointerOver={
          canPick
            ? e => {
                if ((anim.current.get(room.floor)?.opacity ?? 1) < 0.5) return;
                e.stopPropagation();
                onHover(room.code);
              }
            : undefined
        }
        onPointerOut={canPick ? () => onHover(null) : undefined}
      >
        <boxGeometry args={room.size} />
        <meshStandardMaterial
          ref={mat}
          transparent
          depthWrite={false}
          opacity={0.15}
          color="#4b5563"
          emissive="#4b5563"
          emissiveIntensity={0.2}
        />
        {(selected || hovered) && (
          <Edges color={selected ? SCENE_COLORS.selected : SCENE_COLORS.hover} threshold={15} />
        )}
        {/* Anomaly: a static amber outline that stays identifiable with motion off. */}
        {hasAnomaly && (
          <>
            <Edges scale={1.03} color={SCENE_COLORS.anomaly} threshold={15} />
            <Edges scale={1.05} color={SCENE_COLORS.anomaly} threshold={15} />
          </>
        )}
      </mesh>

      <AnomalyPulse room={room} />
    </group>
  );
}

/** One expanding ring when an anomaly is first detected in this room (not under reduced motion). */
function AnomalyPulse({ room }: { room: RoomGeo }) {
  const ring = useRef<Mesh>(null);
  const reduced = useReducedMotion();
  const nonce = useNexus(s => (s.anomalyFlash?.room === room.code ? s.anomalyFlash.nonce : 0));

  useEffect(() => {
    const mesh = ring.current;
    if (!nonce || reduced || !mesh) return;
    const material = mesh.material as MeshBasicMaterial;
    mesh.visible = true;
    mesh.scale.setScalar(0.3);
    material.opacity = 0.9;
    const tl = gsap.timeline({ onComplete: () => void (mesh.visible = false) });
    tl.to(mesh.scale, { x: 1.5, y: 1.5, z: 1.5, duration: 1.4, ease: 'power2.out' }, 0).to(
      material,
      { opacity: 0, duration: 1.4, ease: 'power1.in' },
      0
    );
    return () => void tl.kill();
  }, [nonce, reduced]);

  return (
    <mesh
      ref={ring}
      visible={false}
      position={[room.center[0], room.center[1] - room.size[1] / 2 + 0.05, room.center[2]]}
      rotation={[-Math.PI / 2, 0, 0]}
      raycast={() => null}
    >
      <ringGeometry
        args={[
          Math.min(room.size[0], room.size[2]) * 0.42,
          Math.min(room.size[0], room.size[2]) * 0.5,
          48,
        ]}
      />
      <meshBasicMaterial
        color={SCENE_COLORS.anomaly}
        transparent
        opacity={0}
        side={DoubleSide}
        depthWrite={false}
        blending={AdditiveBlending}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------------------- assets
function AssetLayer({
  floor,
  anim,
  snapshotFn,
  interactive,
}: {
  floor: FloorGeo;
  anim: AnimRef;
  snapshotFn: SnapshotFn;
  interactive: boolean;
}) {
  const kinds = useMemo(() => {
    const map = new Map<string, AssetGeo[]>();
    for (const a of floor.assets) map.set(a.kind, [...(map.get(a.kind) ?? []), a]);
    return [...map.entries()];
  }, [floor.assets]);

  return (
    <>
      {kinds.map(([kind, assets]) => (
        <AssetInstances
          key={kind}
          kind={kind}
          assets={assets}
          level={floor.level}
          anim={anim}
          snapshotFn={snapshotFn}
          interactive={interactive}
        />
      ))}
    </>
  );
}

const STEEL = new Color('#64748b');

function AssetInstances({
  kind,
  assets,
  level,
  anim,
  snapshotFn,
  interactive,
}: {
  kind: string;
  assets: AssetGeo[];
  level: number;
  anim: AnimRef;
  snapshotFn: SnapshotFn;
  interactive: boolean;
}) {
  const mesh = useRef<InstancedMesh>(null);
  const shown = useRef<string[]>([]);

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const matrix = new Matrix4();
    assets.forEach((a, i) => {
      // Meters use a unit cylinder; everything else is a unit box scaled to its size.
      const scale = kind === 'meter' ? new Vector3(1, 1, 1) : new Vector3(...a.size);
      matrix.compose(new Vector3(...a.position), new Quaternion(), scale);
      m.setMatrixAt(i, matrix);
      m.setColorAt(i, STEEL);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [assets, kind]);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const a = anim.current.get(level) ?? DEFAULT_ANIM;
    (m.material as MeshStandardMaterial).opacity = 0.9 * a.opacity;
    m.visible = a.opacity > 0.02;
    const st = useNexus.getState();
    const now = Date.now();
    assets.forEach((asset, i) => {
      // Equipment with a sensor takes that sensor's status colour; plain equipment stays steel.
      const visual = asset.sensorIds.length
        ? worstState(asset.sensorIds.map(id => snapshotFn(st, id, now).visual))
        : null;
      const key = visual ?? 'steel';
      if (shown.current[i] !== key) {
        shown.current[i] = key;
        m.setColorAt(i, visual ? new Color(VISUAL_STATE_STYLE[visual].color) : STEEL);
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    });
  });

  return (
    <>
      <instancedMesh
        ref={mesh}
        args={[undefined, undefined, assets.length]}
        raycast={interactive ? undefined : () => null}
        onClick={
          interactive
            ? e => {
                if ((anim.current.get(level)?.opacity ?? 1) < 0.5) return;
                e.stopPropagation();
                const asset = assets[e.instanceId ?? 0];
                useNexus.getState().select({
                  floor: level,
                  room: null,
                  sensor: asset?.sensorIds[0] ?? null,
                  anomalyId: null,
                  alertId: null,
                });
              }
            : undefined
        }
      >
        {kind === 'meter' ? (
          <cylinderGeometry args={[0.45, 0.45, 1.3, 20]} />
        ) : (
          <boxGeometry args={[1, 1, 1]} />
        )}
        <meshStandardMaterial transparent opacity={0.9} metalness={0.35} roughness={0.55} />
      </instancedMesh>
    </>
  );
}

// ------------------------------------------------------------------------------- energy flow
const FLOW_REFERENCE_KW = 20;

/**
 * Animated power streams from a floor meter to its rooms. They exist only where a power
 * sensor exists and is reporting, and are drawn in the "simulated" colour because the meters
 * are simulated. Speed scales with the metered kW.
 */
function FloorEnergy({
  floor,
  snapshotFn,
  anim,
}: {
  floor: FloorGeo;
  snapshotFn: SnapshotFn;
  anim: AnimRef;
}) {
  const reduced = useReducedMotion();
  const meters = floor.assets.filter(a => a.kind === 'meter' && a.sensorIds.length > 0);
  const lines = useRef<(ComponentRef<typeof Line> | null)[]>([]);

  const flows = useMemo(
    () =>
      meters.flatMap(m =>
        floor.rooms.map(r => ({
          key: `${m.code}-${r.code}`,
          meterSensor: m.sensorIds[0],
          points: [
            [m.position[0], floor.elevation + 0.55, m.position[2]],
            [r.center[0], floor.elevation + 0.55, r.center[2]],
          ] as [number, number, number][],
        }))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [floor]
  );

  useFrame((_, dt) => {
    const st = useNexus.getState();
    const now = Date.now();
    const level = anim.current.get(floor.level) ?? DEFAULT_ANIM;
    flows.forEach((f, i) => {
      const line = lines.current[i];
      if (!line) return;
      const snap = snapshotFn(st, f.meterSensor, now);
      const flowing =
        snap.value !== null &&
        (snap.visual === 'normal' || snap.visual === 'warning' || snap.visual === 'critical');
      line.visible = flowing && level.opacity > 0.3;
      if (!flowing || reduced) return;
      const material = line.material as unknown as { dashOffset: number; opacity: number };
      material.dashOffset -= dt * (0.4 + (snap.value! / FLOW_REFERENCE_KW) * 1.2);
    });
  });

  return (
    <>
      {flows.map((f, i) => (
        <Line
          key={f.key}
          ref={el => void (lines.current[i] = el)}
          points={f.points}
          color={SCENE_COLORS.energy}
          lineWidth={1.6}
          dashed
          dashSize={0.35}
          gapSize={0.25}
          transparent
          opacity={0.75}
          raycast={() => null}
        />
      ))}
    </>
  );
}
