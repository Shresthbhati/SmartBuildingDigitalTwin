import { useState, useEffect, useCallback } from 'react';
import type { AlertListItem, AlertFilter } from '../types';
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

interface AlertListProps {
  initialFilter?: AlertFilter;
  onAlertSelect?: (alert: AlertListItem) => void;
}

export function AlertList({ initialFilter, onAlertSelect }: AlertListProps) {
  const [alerts, setAlerts] = useState<AlertListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AlertFilter>(initialFilter ?? {});
  const [counts, setCounts] = useState<{
    total: number;
    open: number;
  } | null>(null);

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await alertApi.getAlerts(filter);
      setAlerts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alerts');
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  const fetchCounts = useCallback(async () => {
    try {
      const data = await alertApi.getAlertCounts();
      setCounts({
        total: data.total,
        open: data.by_status.find(s => s.status === 'OPEN')?.count ?? 0,
      });
    } catch {
      // counts are non-fatal
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => {
      fetchAlerts();
      fetchCounts();
    });
  }, [fetchAlerts, fetchCounts]);

  const handleFilterChange = (key: keyof AlertFilter, value: string) => {
    setFilter({ ...filter, [key]: value, offset: 0 });
  };

  const handleRowClick = (alert: AlertListItem) => {
    onAlertSelect?.(alert);
  };

  if (loading) {
    return (
      <div className="alert-list loading">
        <p>Loading alerts...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert-list error">
        <p className="error-message">{error}</p>
        <button onClick={fetchAlerts}>Retry</button>
      </div>
    );
  }

  if (alerts.length === 0) {
    return (
      <div className="alert-list empty">
        <p>No alerts found</p>
      </div>
    );
  }

  return (
    <div className="alert-list">
      <div className="alert-list-header">
        <h3>Alerts</h3>
        {counts && (
          <span className="count-badge">
            {counts.total} total • {counts.open} open
          </span>
        )}
      </div>

      <div className="alert-filters">
        <div className="filter-group">
          <label>Status:</label>
          <select
            value={filter.status ?? ''}
            onChange={e => handleFilterChange('status', e.target.value || undefined)}
          >
            <option value="">All</option>
            <option value="OPEN">Open</option>
            <option value="ACKNOWLEDGED">Acknowledged</option>
            <option value="RESOLVED">Resolved</option>
          </select>
        </div>
        <div className="filter-group">
          <label>Severity:</label>
          <select
            value={filter.severity ?? ''}
            onChange={e => handleFilterChange('severity', e.target.value || undefined)}
          >
            <option value="">All</option>
            <option value="CRITICAL">Critical</option>
            <option value="WARNING">Warning</option>
            <option value="INFO">Info</option>
          </select>
        </div>
        <div className="filter-group">
          <label>Room:</label>
          <select
            value={filter.room ?? ''}
            onChange={e => handleFilterChange('room', e.target.value || undefined)}
          >
            <option value="">All</option>
            {[...new Set(alerts.map(a => a.room))].map(room => (
              <option key={room} value={room}>
                {room}
              </option>
            ))}
          </select>
        </div>
      </div>

      <table className="alert-table">
        <thead>
          <tr>
            <th>Room</th>
            <th>Type</th>
            <th>Severity</th>
            <th>Status</th>
            <th>First Occurrence</th>
            <th>Last Occurrence</th>
            <th>Count</th>
            <th>Title</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map(alert => {
            const colors = severityColors[alert.severity] ?? severityColors.INFO;
            return (
              <tr
                key={alert.id}
                className="alert-row"
                onClick={() => handleRowClick(alert)}
                role="button"
                tabIndex={0}
              >
                <td className="alert-room">{alert.room}</td>
                <td className="alert-type">{alert.alert_type}</td>
                <td>
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
                </td>
                <td>
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
                </td>
                <td className="alert-timestamp">
                  {new Date(alert.first_occurrence).toLocaleTimeString()}
                </td>
                <td className="alert-timestamp">
                  {new Date(alert.last_occurrence).toLocaleTimeString()}
                </td>
                <td className="alert-count">{alert.occurrence_count}</td>
                <td className="alert-title">{alert.title}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
