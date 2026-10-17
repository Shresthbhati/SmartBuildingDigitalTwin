import type { LatestDataResponse } from '../types';

const statusColors: Record<string, { bg: string; text: string; border: string }> = {
  NORMAL: { bg: '#1a3a2a', text: '#4ade80', border: '#22c55e' },
  HIGH: { bg: '#3a2a1a', text: '#fbbf24', border: '#f59e0b' },
  ALERT: { bg: '#3a1a1a', text: '#f87171', border: '#ef4444' },
};

interface RoomCardProps {
  data: LatestDataResponse;
  isAlertActive?: boolean;
  onSelect?: (room: string) => void;
}

export function RoomCard({ data, isAlertActive = false, onSelect }: RoomCardProps) {
  const colors = statusColors[data.status] || statusColors.NORMAL;
  const alertBorder = isAlertActive ? '#ef4444' : colors.border;

  return (
    <div
      className="room-card"
      onClick={() => onSelect?.(data.room)}
      role="button"
      tabIndex={0}
      style={
        {
          borderColor: alertBorder,
          background: `linear-gradient(135deg, ${colors.bg} 0%, #0f172a 100%)`,
          cursor: onSelect ? 'pointer' : 'default',
        } as React.CSSProperties
      }
    >
      <div className="room-header">
        <h3 className="room-name">{data.room.toUpperCase()}</h3>
        <span
          className={`status-badge ${isAlertActive ? 'alert-pulse' : ''}`}
          style={
            {
              backgroundColor: colors.bg,
              color: colors.text,
              borderColor: alertBorder,
            } as React.CSSProperties
          }
        >
          {data.status}
        </span>
      </div>
      <div className="temperature-display">
        <span className="temperature-value" style={{ color: colors.text }}>
          {data.temperature.toFixed(1)}
        </span>
        <span className="temperature-unit" style={{ color: colors.text }}>
          °C
        </span>
      </div>
      <div className="status-bar" style={{ backgroundColor: alertBorder }} />
      {isAlertActive && (
        <div className="alert-indicator" title="Active alert">
          <span className="alert-dot" />
          <span className="alert-label">ALERT</span>
        </div>
      )}
    </div>
  );
}
