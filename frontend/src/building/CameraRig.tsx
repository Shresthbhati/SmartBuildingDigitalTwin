import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import gsap from 'gsap';
import { useEffect, useMemo, useRef, type ComponentRef } from 'react';
import { Vector3 } from 'three';
import { useNexus, type FocusRequest } from '../store';
import { broadcastCamera, joinCameraGroup, type CameraPose } from './cameraSync';
import { prefersReducedMotion, type BuildingGeo } from './geometry';

interface CameraRigProps {
  geo: BuildingGeo;
  sensorPositions: Map<string, [number, number, number]>;
  /** Scenes sharing a group keep their cameras in step (scenario split view). */
  syncGroup?: string;
  /** This rig reacts to the store's focus requests (only one scene per page should). */
  followFocus?: boolean;
}

type Controls = ComponentRef<typeof OrbitControls>;

export function homePose(geo: BuildingGeo): CameraPose {
  const [cx, cy, cz] = geo.center;
  const reach = Math.max(geo.width, geo.depth, geo.height * 2);
  return {
    position: [cx + reach * 0.75, cy + reach * 0.62, cz + reach * 1.05],
    target: [cx, cy, cz],
  };
}

/** Where a focus request wants the camera to look, and how far back to stand. */
export function resolveFocus(
  req: FocusRequest,
  geo: BuildingGeo,
  sensorPositions: Map<string, [number, number, number]>
): { target: [number, number, number]; distance: number } | null {
  if (req.sensor) {
    const p = sensorPositions.get(req.sensor);
    if (p) return { target: p, distance: 11 };
  }
  if (req.room) {
    for (const f of geo.floors) {
      const r = f.rooms.find(x => x.code === req.room);
      if (r) return { target: r.center, distance: 13 };
    }
  }
  if (req.floor !== undefined) {
    const f = geo.floors.find(x => x.level === req.floor);
    if (f) {
      return {
        target: [geo.width / 2, f.elevation + f.height / 2, geo.depth / 2],
        distance: Math.max(geo.width, geo.depth) * 1.35,
      };
    }
  }
  return null;
}

export function CameraRig({ geo, sensorPositions, syncGroup, followFocus = true }: CameraRigProps) {
  const camera = useThree(s => s.camera);
  const controls = useRef<Controls>(null);
  const interacting = useRef(false);
  const self = useRef(Symbol('camera'));
  const home = useMemo(() => homePose(geo), [geo]);
  const focusNonce = useNexus(s => (followFocus ? s.focusRequest?.nonce : undefined));

  // Initial pose.
  useEffect(() => {
    camera.position.set(...home.position);
    controls.current?.target.set(...home.target);
    controls.current?.update();
  }, [camera, home]);

  // Move to wherever a focus request points ("Focus camera", "Reset view", deep links).
  useEffect(() => {
    if (focusNonce === undefined) return;
    const req = useNexus.getState().focusRequest;
    const ctl = controls.current;
    if (!req || !ctl) return;

    let to: CameraPose;
    const focus = resolveFocus(req, geo, sensorPositions);
    if (focus) {
      const t = new Vector3(...focus.target);
      const dir = camera.position.clone().sub(ctl.target);
      if (dir.lengthSq() < 1e-6) dir.set(0.6, 0.5, 0.8);
      const pos = t.clone().add(dir.setLength(focus.distance));
      to = { position: [pos.x, pos.y, pos.z], target: focus.target };
    } else {
      to = home;
    }

    const duration = prefersReducedMotion() ? 0 : 1.1;
    const tweens = [
      gsap.to(camera.position, {
        x: to.position[0],
        y: to.position[1],
        z: to.position[2],
        duration,
        ease: 'power2.inOut',
        onUpdate: () => ctl.update(),
      }),
      gsap.to(ctl.target, {
        x: to.target[0],
        y: to.target[1],
        z: to.target[2],
        duration,
        ease: 'power2.inOut',
        onUpdate: () => ctl.update(),
      }),
    ];
    return () => tweens.forEach(t => t.kill());
  }, [focusNonce, geo, sensorPositions, home, camera]);

  // Keep sibling scenes' cameras in step.
  useEffect(() => {
    if (!syncGroup) return;
    return joinCameraGroup(syncGroup, (pose, from) => {
      const ctl = controls.current;
      if (from === self.current || !ctl) return;
      camera.position.set(...pose.position);
      ctl.target.set(...pose.target);
      ctl.update();
    });
  }, [syncGroup, camera]);

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      minDistance={6}
      maxDistance={80}
      maxPolarAngle={Math.PI / 2 - 0.04}
      target={home.target}
      onStart={() => (interacting.current = true)}
      onEnd={() => (interacting.current = false)}
      onChange={() => {
        const ctl = controls.current;
        if (!syncGroup || !interacting.current || !ctl) return;
        const p = camera.position;
        broadcastCamera(
          syncGroup,
          { position: [p.x, p.y, p.z], target: [ctl.target.x, ctl.target.y, ctl.target.z] },
          self.current
        );
      }}
    />
  );
}
