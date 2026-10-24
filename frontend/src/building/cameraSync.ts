// Tiny pub/sub that keeps the cameras of several scenes (e.g. baseline vs scenario) in step.

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

type Listener = (pose: CameraPose, from: symbol) => void;

const groups = new Map<string, Set<Listener>>();

export function joinCameraGroup(group: string, listener: Listener): () => void {
  let set = groups.get(group);
  if (!set) groups.set(group, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) groups.delete(group);
  };
}

export function broadcastCamera(group: string, pose: CameraPose, from: symbol): void {
  groups.get(group)?.forEach(l => l(pose, from));
}
