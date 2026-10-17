import type { HealthResponse, DetailedHealthResponse } from '../types';

interface HeaderProps {
  health: HealthResponse | null;
  detailedHealth?: DetailedHealthResponse | null;
}

export function Header({ health, detailedHealth }: HeaderProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy':
        return '#4ade80';
      case 'degraded':
        return '#fbbf24';
      default:
        return '#ef4444';
    }
  };

  return (
    <header className="app-header">
      <div className="header-left">
        <h1>Smart Building Digital Twin</h1>
        <span className="version-badge">v2.0.0</span>
      </div>
      <div className="header-right">
        <div className="health-indicator">
          <span
            className="health-dot"
            style={
              {
                backgroundColor: health ? getStatusColor(health.status) : '#64748b',
              } as React.CSSProperties
            }
          />
          <span className="health-text">
            {health ? health.status.toUpperCase() : 'CONNECTING...'}
          </span>
        </div>
        {detailedHealth && (
          <>
            <div className="health-details">
              <span>DB: {detailedHealth.database}</span>
              <span>MQTT: {detailedHealth.mqtt}</span>
              <span>Sim: {detailedHealth.simulator.toUpperCase()}</span>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
