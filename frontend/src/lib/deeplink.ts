// Deep links: `?floor=&room=&sensor=&t=` (t = ISO timestamp of the timeline cursor; absent = live).

export interface DeepLink {
  floor: number | null;
  room: string | null;
  sensor: string | null;
  /** Epoch ms of the timeline cursor, or 'live'. */
  t: number | 'live';
}

export function parseDeepLink(search: string): DeepLink {
  const p = new URLSearchParams(search);
  const floorRaw = p.get('floor');
  const floor = floorRaw !== null && /^-?\d+$/.test(floorRaw) ? Number(floorRaw) : null;
  const tRaw = p.get('t');
  const parsed = tRaw && tRaw !== 'live' ? Date.parse(tRaw) : NaN;
  return {
    floor,
    room: p.get('room') || null,
    sensor: p.get('sensor') || null,
    t: Number.isNaN(parsed) ? 'live' : parsed,
  };
}

export function serializeDeepLink(link: DeepLink): string {
  const p = new URLSearchParams();
  if (link.floor !== null) p.set('floor', String(link.floor));
  if (link.room) p.set('room', link.room);
  if (link.sensor) p.set('sensor', link.sensor);
  if (link.t !== 'live') p.set('t', new Date(link.t).toISOString());
  const s = p.toString();
  return s ? `?${s}` : '';
}
