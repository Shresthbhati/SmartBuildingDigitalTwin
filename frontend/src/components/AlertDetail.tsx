import { useState } from 'react';
import type { Alert } from '../types';
import { alertApi } from '../api/client';

const severityColors: Record<string, { text: string; border: string }> = {
  INFO: { text: '#4ade80', border: '#22c55e' },
  WARNING: { text: '#fbbf24', border: '#f59e0b' },
  CRITICAL: { text: '#f87171', border: '#ef4444' },
};

const statusColors: Record<string, string> = {
  OPEN: '#ef4444',
  ACKNOWLEDGED: '#fbbf24',
  RESOLVED: '#4ade80',
};

interface AlertDetailProps {
  alert: Alert | null;
  onClose: () => void;
  onAlertUpdated: () => void;
}

export function AlertDetail({ alert, onClose, onAlertUpdated }: AlertDetailProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAcknowledge = async () => {
    if (!alert) return;
    setLoading(true);
    setError(null);
    try {
      await alertApi.acknowledgeAlert(alert.id);
      onAlertUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to acknowledge alert');
    } finally {
      setLoading(false);
    }
  };

  const handleResolve = async () => {
    if (!alert) return;
    setLoading(true);
    setError(null);
    try {
      await alertApi.resolveAlert(alert.id);
      onAlertUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve alert');
    } finally {
      setLoading(false);
    }
  };

  if (!alert) {
    return null;
  }

  const colors = severityColors[alert.severity] ?? severityColors.INFO;
  const canAck = alert.status === 'OPEN' || alert.status === 'ACKNOWLEDGED';
  const canResolve = alert.status === 'OPEN' || alert.status === 'ACKNOWLEDGED';

  return (
    <div className="alert-detail-panel">
      <div className="alert-detail-header">
        <h3>{alert.title}</h3>
        <button className="close-btn" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="alert-detail-body">
        <div className="detail-grid">
          <div className="detail-row">
            <span className="detail-label">Room</span>
            <span className="detail-value">{alert.room}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Sensor</span>
            <span className="detail-value">{alert.sensor_id}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Type</span>
            <span className="detail-value">{alert.alert_type}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Severity</span>
            <span
              className="severity-badge"
              style={
                {
                  color: colors.text,
                  borderColor: colors.border,
                } as React.CSSProperties
              }
            >
              {alert.severity}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Status</span>
            <span
              className="status-badge"
              style={
                {
                  color: statusColors[alert.status] ?? '#64748b',
                } as React.CSSProperties
              }
            >
              {alert.status}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">First Occurrence</span>
            <span className="detail-value">
              {new Date(alert.first_occurrence).toLocaleString()}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Last Occurrence</span>
            <span className="detail-value">{new Date(alert.last_occurrence).toLocaleString()}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Occurrences</span>
            <span className="detail-value">{alert.occurrence_count}</span>
          </div>
          {alert.last_reading_value !== null && (
            <div className="detail-row">
              <span className="detail-label">Last Reading</span>
              <span className="detail-value">{alert.last_reading_value}°C</span>
            </div>
          )}
          {alert.threshold_value !== null && (
            <div className="detail-row">
              <span className="detail-label">Threshold</span>
              <span className="detail-value">{alert.threshold_value}°C</span>
            </div>
          )}
          {alert.acknowledged_at && (
            <div className="detail-row">
              <span className="detail-label">Acknowledged At</span>
              <span className="detail-value">
                {new Date(alert.acknowledged_at).toLocaleString()}
              </span>
            </div>
          )}
          {alert.acknowledged_by && (
            <div className="detail-row">
              <span className="detail-label">Acknowledged By</span>
              <span className="detail-value">{alert.acknowledged_by}</span>
            </div>
          )}
          {alert.resolved_at && (
            <div className="detail-row">
              <span className="detail-label">Resolved At</span>
              <span className="detail-value">{new Date(alert.resolved_at).toLocaleString()}</span>
            </div>
          )}
        </div>

        <div className="detail-description">
          <span className="detail-label">Description</span>
          <p className="detail-value">{alert.description}</p>
        </div>

        <div className="alert-actions">
          {canAck && alert.status !== 'ACKNOWLEDGED' && (
            <button className="action-btn ack-btn" onClick={handleAcknowledge} disabled={loading}>
              {loading ? 'Acknowledging...' : 'Acknowledge'}
            </button>
          )}
          {canResolve && alert.status !== 'RESOLVED' && (
            <button className="action-btn resolve-btn" onClick={handleResolve} disabled={loading}>
              {loading ? 'Resolving...' : 'Resolve'}
            </button>
          )}
        </div>

        {error && <div className="alert-error">{error}</div>}
      </div>
    </div>
  );
}
