import { formatValue, relativeAge } from '../lib/format';
import { useNow } from '../lib/useNow';
import { useNexus } from '../store';
import { activeEntities, snapshotFor } from '../store/selectors';
import { worstState } from './state';
import { SourceBadge, StatusBadge } from '../state/StateViews';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SnapshotFn } from './sceneTypes';

/**
 * The building as a keyboard-navigable table: the same hierarchy as the 3D scene
 * (floors > rooms/assets > sensors), the same store-derived values, no WebGL needed.
 * Every status is text + icon. Rows are focusable; Enter or Space selects.
 */
export function AccessibleBuilding({ snapshotFn = snapshotFor }: { snapshotFn?: SnapshotFn }) {
  const topology = useNexus(s => s.topology);
  const selected = useNexus(
    useShallow(s => ({ room: s.selection.room, sensor: s.selection.sensor }))
  );
  const isolated = useNexus(s => s.selection.floor);
  const now = useNow(1000);
  const state = useNexus();
  const rows = useMemo(() => {
    const s = state;
    if (!topology) return [];
    const active = activeEntities(s);
    return topology.floors
      .filter(f => isolated === null || f.level === isolated)
      .map(f => ({
        floor: f,
        rooms: f.rooms.map(r => {
          const snaps = r.sensors.map(x => snapshotFn(s, x.sensor_id, now));
          const primary = snaps.find(x => x.type === 'temperature') ?? snaps[0];
          return {
            code: r.code,
            name: r.name,
            visual: snaps.length ? worstState(snaps.map(x => x.visual)) : ('offline' as const),
            value: primary?.value ?? null,
            unit: primary?.unit ?? '',
            source: primary?.source ?? null,
            timestampMs: primary?.timestampMs ?? null,
            gap: primary?.gap ?? false,
            sensorId: primary?.sensorId ?? null,
            alerts: active.alertRooms.has(r.code),
            anomalies: active.anomaliesByRoom.get(r.code)?.length ?? 0,
          };
        }),
        assets: f.assets.map(a => {
          const snaps = a.sensors.map(x => snapshotFn(s, x.sensor_id, now));
          const primary = snaps[0];
          return {
            code: a.code,
            name: a.name,
            kind: a.kind,
            visual: snaps.length ? worstState(snaps.map(x => x.visual)) : null,
            value: primary?.value ?? null,
            unit: primary?.unit ?? '',
            source: primary?.source ?? null,
            timestampMs: primary?.timestampMs ?? null,
            sensorId: primary?.sensorId ?? null,
          };
        }),
      }));
  }, [state, topology, isolated, snapshotFn, now]);

  if (!topology) return null;
  const select = useNexus.getState().select;

  return (
    <div className="accessible-building">
      <table className="data-table" aria-label="Building rooms and equipment with current status">
        <caption>
          Building overview. Select a row (Enter or Space) to open it in the inspector.
        </caption>
        <thead>
          <tr>
            <th scope="col">Location</th>
            <th scope="col">Status</th>
            <th scope="col">Value</th>
            <th scope="col">Data source</th>
            <th scope="col">Last reading</th>
            <th scope="col">Open items</th>
          </tr>
        </thead>
        {rows.map(({ floor, rooms, assets }) => (
          <tbody key={floor.level}>
            <tr className="floor-row">
              <th scope="rowgroup" colSpan={6}>
                {floor.name}
              </th>
            </tr>
            {rooms.map(r => (
              <tr
                key={r.code}
                tabIndex={0}
                aria-selected={selected.room === r.code}
                className={selected.room === r.code ? 'selected' : ''}
                onClick={() =>
                  select({ room: r.code, sensor: null, anomalyId: null, alertId: null })
                }
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    select({ room: r.code, sensor: null, anomalyId: null, alertId: null });
                  }
                }}
              >
                <th scope="row">{r.name}</th>
                <td>
                  <StatusBadge state={r.visual} />
                </td>
                <td className="mono">{r.gap ? 'gap' : formatValue(r.value, r.unit)}</td>
                <td>{r.source ? <SourceBadge source={r.source} /> : '—'}</td>
                <td>{r.timestampMs !== null ? relativeAge(r.timestampMs, now) : 'never'}</td>
                <td>
                  {r.anomalies > 0 && (
                    <span className="chip anomaly">
                      σ {r.anomalies} anomal{r.anomalies === 1 ? 'y' : 'ies'}
                    </span>
                  )}{' '}
                  {r.alerts && <span className="chip alert">▲ threshold alert</span>}
                  {!r.anomalies && !r.alerts && '—'}
                </td>
              </tr>
            ))}
            {assets.map(a => (
              <tr
                key={a.code}
                tabIndex={0}
                aria-selected={a.sensorId !== null && selected.sensor === a.sensorId}
                className={a.sensorId !== null && selected.sensor === a.sensorId ? 'selected' : ''}
                onClick={() =>
                  a.sensorId &&
                  select({ sensor: a.sensorId, room: null, anomalyId: null, alertId: null })
                }
                onKeyDown={e => {
                  if ((e.key === 'Enter' || e.key === ' ') && a.sensorId) {
                    e.preventDefault();
                    select({ sensor: a.sensorId, room: null, anomalyId: null, alertId: null });
                  }
                }}
              >
                <th scope="row">
                  {a.name} <span className="dim">({a.kind})</span>
                </th>
                <td>
                  {a.visual ? (
                    <StatusBadge state={a.visual} />
                  ) : (
                    <span className="dim">No sensor</span>
                  )}
                </td>
                <td className="mono">{formatValue(a.value, a.unit, 2)}</td>
                <td>{a.source ? <SourceBadge source={a.source} /> : '—'}</td>
                <td>{a.timestampMs !== null ? relativeAge(a.timestampMs, now) : '—'}</td>
                <td>—</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
