import { useState, useEffect, useCallback, useRef } from 'react';
import { sensorApi } from '../api/client';
import type { RoomTelemetryState } from './state';
import type { SensorReading, AggregateBucket } from '../types';
import { TemperatureChart } from '../components/TemperatureChart';
import './RoomInspectionPanel.css';

interface RoomInspectionPanelProps {
  roomTelemetry: RoomTelemetryState;
  onClose: () => void;
  timeRange: { start: string; end: string; interval: string };
  useAggregate: boolean;
}

export function RoomInspectionPanel({
  roomTelemetry,
  onClose,
  timeRange,
  useAggregate,
}: RoomInspectionPanelProps) {
  const [history, setHistory] = useState<SensorReading[]>(() => roomTelemetry.history);
  const [aggregate, setAggregate] = useState<AggregateBucket[]>(() => roomTelemetry.aggregate);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAggregate, setShowAggregate] = useState(useAggregate);
  const requestIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    const currentRequestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      if (!showAggregate) {
        const historyRes = await sensorApi.getRoomHistory(roomTelemetry.roomId, {
          start: timeRange.start,
          end: timeRange.end,
          limit: 500,
        });
        if (currentRequestId === requestIdRef.current) {
          setHistory(historyRes.readings);
        }
      } else {
        const agg = await sensorApi.getAggregate({
          room: roomTelemetry.roomId,
          sensor_id: roomTelemetry.sensorId || `temp-sensor-${roomTelemetry.roomId.slice(-3)}`,
          start: timeRange.start,
          end: timeRange.end,
          interval: timeRange.interval,
        });
        if (currentRequestId === requestIdRef.current) {
          setAggregate(agg.buckets);
        }
      }
    } catch (err) {
      if (currentRequestId === requestIdRef.current) {
        setError('Failed to fetch chart data');
        console.error('Chart data fetch error:', err);
      }
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [roomTelemetry.roomId, roomTelemetry.sensorId, timeRange, showAggregate]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowAggregate(useAggregate);
  }, [useAggregate]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory(roomTelemetry.history);
    setAggregate(roomTelemetry.aggregate);
  }, [roomTelemetry.history, roomTelemetry.aggregate]);

  const statusColors: Record<string, string> = {
    NORMAL: '#4ade80',
    HIGH: '#fbbf24',
    ALERT: '#ef4444',
    UNKNOWN: '#64748b',
  };

  const statusColor = statusColors[roomTelemetry.status] || statusColors.UNKNOWN;

  const formatTimestamp = (ts: string | null) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleString();
  };

  const isStale = roomTelemetry.isStale;
  const lastUpdated = roomTelemetry.lastUpdated;

  return (
    <div
      className="room-inspection-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="panel-title"
    >
      <div className="panel-header">
        <h2 id="panel-title">{roomTelemetry.roomName}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>

      <div className="panel-content">
        <div className="room-summary">
          <div className="summary-grid">
            <div className="summary-item">
              <span className="summary-label">Current Temperature</span>
              <span className="summary-value" style={{ color: statusColor }}>
                {roomTelemetry.currentTemperature !== null
                  ? `${roomTelemetry.currentTemperature.toFixed(1)}°C`
                  : 'No data'}
              </span>
            </div>
            <div className="summary-item">
              <span className="summary-label">Status</span>
              <span
                className={`status-badge ${roomTelemetry.status.toLowerCase()}`}
                style={{ backgroundColor: statusColor }}
              >
                {roomTelemetry.status}
              </span>
            </div>
            <div className="summary-item">
              <span className="summary-label">Sensor</span>
              <span className="summary-value">{roomTelemetry.sensorId || '—'}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">Floor</span>
              <span className="summary-value">{roomTelemetry.floor}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">Provenance</span>
              <span className={`source-badge ${roomTelemetry.source || 'unknown'}`}>
                {roomTelemetry.source || 'Unknown'}
              </span>
            </div>
            <div className="summary-item">
              <span className="summary-label">Last Updated</span>
              <span className="summary-value">{formatTimestamp(lastUpdated)}</span>
            </div>
            {isStale && (
              <div className="summary-item stale-warning">
                <span className="summary-label">⚠ Data Stale</span>
                <span className="summary-value">{'Last update > 30s ago'}</span>
              </div>
            )}
          </div>
        </div>

        <div className="chart-section">
          <div className="chart-controls">
            <h3>Temperature History</h3>
            <div className="chart-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={showAggregate}
                  onChange={e => setShowAggregate(e.target.checked)}
                />
                Aggregated View
              </label>
            </div>
          </div>

          {loading && <div className="chart-loading">Loading chart data...</div>}
          {error && <div className="chart-error">{error}</div>}
          {!loading && !error && (
            <TemperatureChart
              readings={showAggregate ? undefined : history}
              aggregate={showAggregate ? aggregate : undefined}
              room={roomTelemetry.roomName}
              useAggregate={showAggregate}
            />
          )}
        </div>
      </div>
    </div>
  );
}
