import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useNexus } from '../store';
import { SOURCE_STYLE, VISUAL_STATE_STYLE, type VisualState } from './state';

const NO_FLOORS: never[] = []; // stable reference: a fresh [] per call would loop the store hook

export function FloorSelector() {
  const floors = useNexus(s => s.topology?.floors ?? NO_FLOORS);
  const isolated = useNexus(s => s.selection.floor);
  const select = useNexus(s => s.select);
  const requestFocus = useNexus(s => s.requestFocus);
  return (
    <div className="floor-selector" role="group" aria-label="Floor isolation">
      <button
        type="button"
        className="btn"
        aria-pressed={isolated === null}
        onClick={() => select({ floor: null })}
      >
        All floors
      </button>
      {floors.map(f => (
        <button
          key={f.level}
          type="button"
          className="btn"
          aria-pressed={isolated === f.level}
          onClick={() => {
            select({ floor: f.level });
            requestFocus({ floor: f.level });
          }}
        >
          {f.name}
        </button>
      ))}
    </div>
  );
}

export function SceneToolbar({
  hasEnergy,
  showEnergy,
  onToggleEnergy,
}: {
  hasEnergy: boolean;
  showEnergy: boolean;
  onToggleEnergy: () => void;
}) {
  const view = useNexus(s => s.ui.view);
  const setUi = useNexus(s => s.setUi);
  const requestFocus = useNexus(s => s.requestFocus);
  return (
    <div className="scene-toolbar">
      <FloorSelector />
      <div className="btn-group" role="group" aria-label="View">
        <button
          type="button"
          className="btn"
          aria-pressed={view === '3d'}
          onClick={() => setUi({ view: '3d' })}
        >
          3D
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={view === 'list'}
          onClick={() => setUi({ view: 'list' })}
        >
          List
        </button>
      </div>
      {view === '3d' && (
        <>
          <button type="button" className="btn" onClick={() => requestFocus({})}>
            Reset view
          </button>
          {hasEnergy && (
            <button
              type="button"
              className="btn"
              aria-pressed={showEnergy}
              onClick={onToggleEnergy}
            >
              Energy flow (simulated)
            </button>
          )}
        </>
      )}
    </div>
  );
}

const LEGEND_STATES: VisualState[] = ['normal', 'warning', 'critical', 'stale', 'offline'];

export function Legend() {
  return (
    <details className="legend" open>
      <summary>Legend</summary>
      <ul>
        {LEGEND_STATES.map(s => (
          <li key={s}>
            <span style={{ color: VISUAL_STATE_STYLE[s].color }} aria-hidden="true">
              {VISUAL_STATE_STYLE[s].icon}
            </span>{' '}
            {VISUAL_STATE_STYLE[s].label}{' '}
            <span className="dim">· {VISUAL_STATE_STYLE[s].description}</span>
          </li>
        ))}
        <li>
          <span style={{ color: SOURCE_STYLE.simulated.color }} aria-hidden="true">
            ◇
          </span>{' '}
          Violet ring: simulated data
        </li>
        <li>
          <span style={{ color: SOURCE_STYLE.scenario.color }} aria-hidden="true">
            ◇
          </span>{' '}
          Large ring: scenario-injected
        </li>
        <li>
          <span style={{ color: '#fbbf24' }} aria-hidden="true">
            σ
          </span>{' '}
          Amber outline: statistical anomaly
        </li>
        <li>
          <span style={{ color: '#fbbf24' }} aria-hidden="true">
            ▲
          </span>{' '}
          Threshold alert
        </li>
      </ul>
    </details>
  );
}

/** New-anomaly notice with the "Focus camera" action. Identifiable with motion off. */
export function AnomalyToast() {
  const flash = useNexus(s => s.anomalyFlash);
  const [dismissed, setDismissed] = useState(0);
  const select = useNexus(s => s.select);
  const requestFocus = useNexus(s => s.requestFocus);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setDismissed(flash.nonce), 20000);
    return () => window.clearTimeout(id);
  }, [flash]);

  if (!flash || flash.nonce === dismissed) return null;
  return (
    <div className="toast anomaly" role="status">
      <span aria-hidden="true">σ</span>
      <div>
        <strong>New statistical anomaly</strong>
        <div className="dim">
          {flash.room} · {flash.sensorId}
        </div>
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => {
          select({ room: flash.room, anomalyId: flash.id, sensor: null });
          requestFocus({ room: flash.room });
        }}
      >
        Focus camera
      </button>
      <Link
        className="btn"
        to={`/investigate?room=${encodeURIComponent(flash.room)}`}
        onClick={() => select({ room: flash.room, anomalyId: flash.id })}
      >
        Investigate
      </Link>
      <button
        type="button"
        className="icon-btn"
        aria-label="Dismiss"
        onClick={() => setDismissed(flash.nonce)}
      >
        ✕
      </button>
    </div>
  );
}
