import { Billboard } from '@react-three/drei';
import type { LayoutRoom } from './layout';
import type { RoomTelemetryState } from './state';
import { getRoomVisualState } from './state';
import './RoomMarker.css';

interface RoomMarkerProps {
  room: LayoutRoom;
  telemetry: RoomTelemetryState | undefined;
  color: string;
  opacity: number;
  isSelected: boolean;
  isHovered: boolean;
  hasActiveAlert: boolean;
  onClick: () => void;
  onHover: () => void;
  onLeave: () => void;
}

export function RoomMarker({
  room,
  telemetry,
  color,
  opacity: _opacity,
  isSelected,
  isHovered,
  hasActiveAlert,
  onClick,
  onHover,
  onLeave,
}: RoomMarkerProps) {
  const visualState = telemetry ? getRoomVisualState(telemetry) : 'unknown';
  const temperature = telemetry?.currentTemperature ?? null;
  const status = telemetry?.status || 'UNKNOWN';
  const source = telemetry?.source;

  return (
    <Billboard follow={true} lockX={true} lockY={false} lockZ={true}>
      <div
        className={`room-marker ${isSelected ? 'selected' : ''} ${isHovered ? 'hovered' : ''} ${visualState} ${hasActiveAlert ? 'alert-active' : ''}`}
        onClick={onClick}
        onMouseEnter={onHover}
        onMouseLeave={onLeave}
      >
        <div className="marker-header">
          <span className="room-name">{room.name}</span>
          <span
            className={`status-badge ${status.toLowerCase()} ${hasActiveAlert ? 'alert-pulse' : ''}`}
          >
            {status}
          </span>
        </div>
        {temperature !== null && (
          <div className="temperature-display">
            <span className="temp-value" style={{ color }}>
              {temperature.toFixed(1)}
            </span>
            <span className="temp-unit">°C</span>
          </div>
        )}
        {temperature === null && <div className="no-data">No data</div>}
        <div className="marker-meta">
          {source && <span className="source-badge">{source}</span>}
          {telemetry?.isStale && <span className="stale-badge">Stale</span>}
          {hasActiveAlert && <span className="alert-badge">ALERT</span>}
        </div>
      </div>
    </Billboard>
  );
}
