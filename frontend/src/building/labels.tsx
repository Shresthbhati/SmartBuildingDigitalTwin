import { useFrame } from '@react-three/fiber';
import { useMemo, type MutableRefObject, type ReactNode } from 'react';
import { Vector3 } from 'three';
import { useShallow } from 'zustand/react/shallow';
import { formatValue, relativeAge } from '../lib/format';
import { useNow } from '../lib/useNow';
import { useNexus } from '../store';
import type { ActiveEntities } from '../store/selectors';
import { ROOM_HEIGHT, type BuildingGeo } from './geometry';
import { DEFAULT_ANIM, type AnimRef, type SnapshotFn } from './sceneTypes';
import { SOURCE_STYLE, VISUAL_STATE_STYLE, worstState, type VisualState } from './state';

// Scene labels are plain DOM positioned over the canvas, not drei <Html>: that component
// mounts a nested React root per label and warns about unmounting during render.

export interface LabelSpec {
  id: string;
  floor: number;
  /** World position the label is anchored to (before the floor's intro offset). */
  position: [number, number, number];
  node: ReactNode;
  interactive?: boolean;
}

type ElMap = MutableRefObject<Map<string, HTMLElement>>;

/** DOM side: renders each label into an absolutely positioned slot. */
export function LabelLayer({ specs, elsRef }: { specs: LabelSpec[]; elsRef: ElMap }) {
  return (
    <div className="label-layer">
      {specs.map(s => (
        <div
          key={s.id}
          className={`label-slot ${s.interactive ? 'interactive' : ''}`}
          ref={el => {
            if (el) elsRef.current.set(s.id, el);
            else elsRef.current.delete(s.id);
          }}
        >
          {s.node}
        </div>
      ))}
    </div>
  );
}

/** Canvas side: every frame, project each anchor through the camera and move its slot there. */
export function LabelProjector({
  specs,
  elsRef,
  anim,
}: {
  specs: LabelSpec[];
  elsRef: ElMap;
  anim: AnimRef;
}) {
  const v = useMemo(() => new Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const s of specs) {
      const el = elsRef.current.get(s.id);
      if (!el) continue;
      const a = anim.current.get(s.floor) ?? DEFAULT_ANIM;
      v.set(s.position[0], s.position[1] + a.dy, s.position[2]).project(camera);
      const visible = v.z > -1 && v.z < 1 && a.opacity > 0.5;
      el.style.display = visible ? '' : 'none';
      if (visible) {
        el.style.transform = `translate(${(v.x * 0.5 + 0.5) * size.width}px, ${(-v.y * 0.5 + 0.5) * size.height}px) translate(-50%, -50%)`;
      }
    }
  });
  return null;
}

function summarize(
  state: ReturnType<typeof useNexus.getState>,
  ids: string[],
  snapshotFn: SnapshotFn,
  now: number
) {
  const snaps = ids.map(id => snapshotFn(state, id, now));
  const primary = snaps.find(s => s.type === 'temperature') ?? snaps[0];
  return {
    visual: (snaps.length ? worstState(snaps.map(s => s.visual)) : 'offline') as VisualState,
    value: primary?.value ?? null,
    unit: primary?.unit ?? '',
    timestampMs: primary?.timestampMs ?? null,
    source: primary?.source ?? null,
    gap: primary?.gap ?? false,
  };
}

function RoomLabel({
  name,
  sensorIds,
  code,
  snapshotFn,
  hovered,
}: {
  name: string;
  sensorIds: string[];
  code: string;
  snapshotFn: SnapshotFn;
  hovered: boolean;
}) {
  const now = useNow(1000);
  const selected = useNexus(s => s.selection.room === code);
  const s = useNexus(useShallow(state => summarize(state, sensorIds, snapshotFn, now)));
  const style = VISUAL_STATE_STYLE[s.visual];
  const expanded = hovered || selected;
  return (
    <div className={`room-label ${s.visual} ${expanded ? 'expanded' : ''}`}>
      <span className="room-label-name">{name.replace('Room ', '')}</span>
      <span className="room-label-value" style={{ color: style.color }}>
        <span aria-hidden="true">{style.icon}</span> {s.gap ? 'gap' : formatValue(s.value, s.unit)}
      </span>
      {expanded && (
        <span className="room-label-detail">
          {style.label}
          {s.source && <> · {SOURCE_STYLE[s.source].label}</>}
          {s.timestampMs !== null && <> · {relativeAge(s.timestampMs, now)}</>}
        </span>
      )}
    </div>
  );
}

/** Room labels, anomaly/alert markers and equipment tags for the whole building. */
export function buildLabelSpecs(
  geo: BuildingGeo,
  active: ActiveEntities,
  hoveredRoom: string | null,
  snapshotFn: SnapshotFn
): LabelSpec[] {
  const specs: LabelSpec[] = [];
  for (const f of geo.floors) {
    for (const r of f.rooms) {
      const top = r.center[1] + ROOM_HEIGHT / 2;
      specs.push({
        id: `room:${r.code}`,
        floor: f.level,
        position: [r.center[0], top + 0.35, r.center[2]],
        node: (
          <RoomLabel
            name={r.name}
            code={r.code}
            sensorIds={r.sensorIds}
            snapshotFn={snapshotFn}
            hovered={hoveredRoom === r.code}
          />
        ),
      });
      const anomalyIds = active.anomaliesByRoom.get(r.code) ?? [];
      if (anomalyIds.length) {
        specs.push({
          id: `anomaly:${r.code}`,
          floor: f.level,
          position: [r.center[0] + r.size[0] / 2 - 0.4, top - 0.2, r.center[2]],
          interactive: true,
          node: (
            <button
              type="button"
              className="scene-marker anomaly"
              title={`${anomalyIds.length} open statistical anomal${anomalyIds.length === 1 ? 'y' : 'ies'} in ${r.name}`}
              aria-label={`${anomalyIds.length} open anomal${anomalyIds.length === 1 ? 'y' : 'ies'} in ${r.name}. Open details.`}
              onClick={() =>
                useNexus
                  .getState()
                  .select({ room: r.code, anomalyId: anomalyIds[0], sensor: null, alertId: null })
              }
            >
              σ
            </button>
          ),
        });
      }
      if (active.alertRooms.has(r.code)) {
        specs.push({
          id: `alert:${r.code}`,
          floor: f.level,
          position: [r.center[0] - r.size[0] / 2 + 0.4, top - 0.2, r.center[2]],
          node: (
            <span
              className="scene-marker alert"
              role="img"
              title={`Open threshold alert in ${r.name}`}
              aria-label={`Open threshold alert in ${r.name}`}
            >
              ▲
            </span>
          ),
        });
      }
    }
    for (const a of f.assets) {
      specs.push({
        id: `asset:${a.code}`,
        floor: f.level,
        position: [a.position[0], a.position[1] + a.size[1] / 2 + 0.25, a.position[2]],
        node: (
          <span className="asset-label">{a.kind === 'meter' ? 'Meter' : a.kind.toUpperCase()}</span>
        ),
      });
    }
  }
  return specs;
}
