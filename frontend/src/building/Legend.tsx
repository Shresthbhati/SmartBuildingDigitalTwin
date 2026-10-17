import type { RoomTelemetryState } from './state';
import { VISUAL_STATE_COLORS } from './state';
import './Legend.css';

interface LegendProps {
  roomsTelemetry: Map<string, RoomTelemetryState>;
  selectedRoomId: string | null;
}

export function Legend({ roomsTelemetry, selectedRoomId }: LegendProps) {
  const states = [
    { key: 'normal', label: 'Normal', color: VISUAL_STATE_COLORS.normal },
    { key: 'warning', label: 'Warning', color: VISUAL_STATE_COLORS.warning },
    { key: 'critical', label: 'Critical', color: VISUAL_STATE_COLORS.critical },
    { key: 'stale', label: 'Stale Data', color: VISUAL_STATE_COLORS.stale },
    { key: 'unknown', label: 'No Data', color: VISUAL_STATE_COLORS.unknown },
  ];

  const statusCounts = {
    NORMAL: 0,
    HIGH: 0,
    ALERT: 0,
    UNKNOWN: 0,
  };

  roomsTelemetry.forEach(room => {
    if (room.status in statusCounts) {
      statusCounts[room.status as keyof typeof statusCounts]++;
    }
  });

  return (
    <div className="legend">
      <div className="legend-section">
        <h4>Room Status</h4>
        <div className="legend-grid">
          {states.map(state => (
            <div key={state.key} className="legend-item">
              <span className="legend-color" style={{ backgroundColor: state.color }} />
              <span className="legend-label">{state.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="legend-section">
        <h4>Counts</h4>
        <div className="legend-counts">
          <div className="count-item normal">
            <span className="count-value">{statusCounts.NORMAL}</span>
            <span className="count-label">Normal</span>
          </div>
          <div className="count-item warning">
            <span className="count-value">{statusCounts.HIGH}</span>
            <span className="count-label">Warning</span>
          </div>
          <div className="count-item critical">
            <span className="count-value">{statusCounts.ALERT}</span>
            <span className="count-label">Critical</span>
          </div>
          <div className="count-item unknown">
            <span className="count-value">{statusCounts.UNKNOWN}</span>
            <span className="count-label">Unknown</span>
          </div>
        </div>
      </div>

      <div className="legend-section">
        <h4>Interaction</h4>
        <div className="legend-keys">
          <div className="key-item">
            <kbd>Click</kbd> Select room
          </div>
          <div className="key-item">
            <kbd>Hover</kbd> Show details
          </div>
          <div className="key-item">
            <kbd>Drag</kbd> Orbit camera
          </div>
          <div className="key-item">
            <kbd>Shift+Drag</kbd> Pan camera
          </div>
          <div className="key-item">
            <kbd>Scroll</kbd> Zoom
          </div>
        </div>
      </div>

      {selectedRoomId && (
        <div className="legend-section selected-room">
          <h4>Selected Room</h4>
          <p>{selectedRoomId}</p>
        </div>
      )}
    </div>
  );
}
