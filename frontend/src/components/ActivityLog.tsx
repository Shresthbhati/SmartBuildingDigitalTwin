import type { ActivityLog } from '../types';

interface ActivityLogProps {
  logs: ActivityLog[];
}

const levelColors: Record<string, string> = {
  NORMAL: '#4ade80',
  HIGH: '#fbbf24',
  ALERT: '#f87171',
};

export function ActivityLog({ logs }: ActivityLogProps) {
  if (logs.length === 0) {
    return (
      <div className="activity-log">
        <h3>Activity Log</h3>
        <div className="activity-empty">No activity recorded yet</div>
      </div>
    );
  }

  return (
    <div className="activity-log">
      <h3>Activity Log</h3>
      <ul className="activity-list">
        {logs.map(log => (
          <li
            key={log.id}
            className="activity-item"
            style={{ borderLeftColor: levelColors[log.level] || levelColors.NORMAL }}
          >
            <span className="activity-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
            <span className="activity-message">{log.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
