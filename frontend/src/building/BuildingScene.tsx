import { Canvas, useFrame } from '@react-three/fiber';
import { useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ErrorState, LoadingState } from '../state/StateViews';
import { useNexus } from '../store';
import { activeEntities, snapshotFor } from '../store/selectors';
import { AccessibleBuilding } from './AccessibleBuilding';
import { CameraRig } from './CameraRig';
import { FloorGroup } from './FloorGroup';
import { buildGeometry, sensorPositions, webglSupported, type BuildingGeo } from './geometry';
import { buildLabelSpecs, LabelLayer, LabelProjector } from './labels';
import { SceneBoundary } from './SceneBoundary';
import { AnomalyToast, Legend, SceneToolbar } from './SceneOverlay';
import { DEFAULT_ANIM, DIMMED_OPACITY, type AnimRef, type SnapshotFn } from './sceneTypes';
import { SCENE_COLORS } from './state';
import { TelemetryRenderer } from './TelemetryRenderer';
import { useIntro, type IntroProgress } from './useIntro';

export interface BuildingSceneProps {
  /** Compact: no toolbar/legend/toast/intro (used for the scenario split view). */
  compact?: boolean;
  syncGroup?: string;
  snapshotFn?: SnapshotFn;
  caption?: string;
  interactive?: boolean;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Animates per-floor opacity (floor isolation) and the intro's descent. */
function FloorAnimator({
  geo,
  anim,
  intro,
}: {
  geo: BuildingGeo;
  anim: AnimRef;
  intro: MutableRefObject<IntroProgress>;
}) {
  useFrame((_, dt) => {
    const isolated = useNexus.getState().selection.floor;
    const n = geo.floors.length;
    geo.floors.forEach((f, i) => {
      const cur = anim.current.get(f.level) ?? { ...DEFAULT_ANIM };
      const target = isolated === null || isolated === f.level ? 1 : DIMMED_OPACITY;
      cur.opacity += (target - cur.opacity) * (1 - Math.exp(-dt * 8));
      const p = clamp01((intro.current.descend - i * 0.12) / (1 - 0.12 * Math.max(n - 1, 0)));
      cur.dy = (1 - easeOut(p)) * 10;
      anim.current.set(f.level, cur);
    });
  });
  return null;
}

export function BuildingScene({
  compact = false,
  syncGroup,
  snapshotFn = snapshotFor,
  caption,
  interactive = true,
}: BuildingSceneProps) {
  const topology = useNexus(s => s.topology);
  const loadState = useNexus(s => s.load.topology);
  const topoError = useNexus(s => s.errors.topology);
  const view = useNexus(s => s.ui.view);
  const bootstrap = useNexus(s => s.bootstrap);
  const geo = useMemo(() => buildGeometry(topology), [topology]);
  const positions = useMemo(() => sensorPositions(geo), [geo]);
  const hasMeter = useMemo(
    () => geo.floors.some(f => f.assets.some(a => a.kind === 'meter' && a.sensorIds.length)),
    [geo]
  );
  const [showEnergy, setShowEnergy] = useState(true);
  const [hovered, setHovered] = useState<string | null>(null);
  const anim: AnimRef = useRef(new Map());
  const supported = useMemo(() => webglSupported(), []);
  const {
    progress: intro,
    active: introActive,
    skip,
  } = useIntro(!compact && geo.floors.length > 0);

  // Re-evaluated only when what drives outlines/markers changes.
  const [alerts, anomalies, cursor, replayData] = useNexus(
    useShallow(s => [s.alerts, s.anomalies, s.cursor, s.replay.data] as const)
  );
  const active = useMemo(
    () => activeEntities(useNexus.getState()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [alerts, anomalies, cursor, replayData]
  );

  const labelEls = useRef(new Map<string, HTMLElement>());
  const labelSpecs = useMemo(
    () => (compact ? [] : buildLabelSpecs(geo, active, hovered, snapshotFn)),
    [compact, geo, active, hovered, snapshotFn]
  );

  if (loadState === 'loading' || loadState === 'idle')
    return <LoadingState label="Loading building" />;
  if (loadState === 'error')
    return (
      <ErrorState
        title="Couldn’t load the building"
        message={topoError}
        onRetry={() => void bootstrap()}
      />
    );

  const list = <AccessibleBuilding snapshotFn={snapshotFn} />;
  if (view === 'list' && !compact) {
    return (
      <div className="scene">
        <SceneToolbar hasEnergy={false} showEnergy={false} onToggleEnergy={() => {}} />
        {list}
      </div>
    );
  }

  return (
    <div className={`scene ${compact ? 'compact' : ''}`} onClick={introActive ? skip : undefined}>
      {!compact && (
        <SceneToolbar
          hasEnergy={hasMeter}
          showEnergy={showEnergy}
          onToggleEnergy={() => setShowEnergy(v => !v)}
        />
      )}
      <div className="canvas-wrap">
        {caption && <div className="scene-caption">{caption}</div>}
        {!supported ? (
          <div className="state-banner partial">
            3D is unavailable in this browser (no WebGL). Showing the list view.
          </div>
        ) : (
          <SceneBoundary
            fallback={err => (
              <div className="state-banner partial">
                3D failed to start ({err.message}). Showing the list view.
              </div>
            )}
          >
            <Canvas
              dpr={[1, 2]}
              camera={{ fov: 42, near: 0.1, far: 300 }}
              gl={{ antialias: true, powerPreference: 'high-performance' }}
              onPointerMissed={() => setHovered(null)}
              aria-label="3D model of the building"
            >
              <color attach="background" args={[SCENE_COLORS.background]} />
              <fog attach="fog" args={[SCENE_COLORS.background, 60, 140]} />
              <ambientLight intensity={0.7} />
              <directionalLight position={[20, 30, 15]} intensity={1.1} />
              <directionalLight position={[-15, 12, -10]} intensity={0.35} />
              <CameraRig
                geo={geo}
                sensorPositions={positions}
                syncGroup={syncGroup}
                followFocus={!compact}
              />
              <FloorAnimator geo={geo} anim={anim} intro={intro} />
              <LabelProjector specs={labelSpecs} elsRef={labelEls} anim={anim} />
              {geo.floors.map(f => (
                <FloorGroup
                  key={f.level}
                  floor={f}
                  anim={anim}
                  intro={intro}
                  active={active}
                  snapshotFn={snapshotFn}
                  hoveredRoom={hovered}
                  onHover={setHovered}
                  interactive={interactive}
                  showEnergy={showEnergy && hasMeter}
                />
              ))}
              <TelemetryRenderer
                geo={geo}
                positions={positions}
                anim={anim}
                intro={intro}
                snapshotFn={snapshotFn}
                interactive={interactive}
              />
            </Canvas>
          </SceneBoundary>
        )}
        {supported && <LabelLayer specs={labelSpecs} elsRef={labelEls} />}
        {introActive && <div className="intro-hint">Click anywhere to skip intro</div>}
        {!compact && (
          <>
            <Legend />
            <AnomalyToast />
          </>
        )}
      </div>
      {/* The same building as a table: the fallback when 3D can't run. */}
      {!compact && !supported && list}
    </div>
  );
}
