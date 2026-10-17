import type { AlertCountsResponse } from '../types';

const severityColors: Record<string, { bg: string; text: string; border: string }> = {
  INFO: { bg: '#1a3a2a', text: '#4ade80', border: '#22c55e' },
  WARNING: { bg: '#3a2a1a', text: '#fbbf24', border: '#f59e0b' },
  CRITICAL: { bg: '#3a1a1a', text: '#f87171', border: '#ef4444' },
};

interface AlertSummaryProps {
  counts: AlertCountsResponse | null;
  onAlertsClick: () => void;
}

export function AlertSummary({ counts, onAlertsClick }: AlertSummaryProps) {
  const bySeverity: Record<string, number> = {};
  let total = 0;
  if (counts) {
    total = counts.total;
    for (const item of counts.by_severity) {
      bySeverity[item.severity] = item.count;
    }
  }

  const openCount = counts?.by_status.find(s => s.status === 'OPEN')?.count ?? 0;
  const ackedCount = counts?.by_status.find(s => s.status === 'ACKNOWLEDGED')?.count ?? 0;
  const resolvedCount = counts?.by_status.find(s => s.status === 'RESOLVED')?.count ?? 0;

  return (
    <section
      className="alert-summary"
      onClick={onAlertsClick}
      role="region"
      aria-label="Alert summary"
    >
      <div className="alert-summary-header">
        <h3>Active Alerts</h3>
        <span className={`total-badge ${total > 0 ? 'has-alerts' : 'no-alerts'}`}>{total}</span>
      </div>

      <div className="alert-summary-grid">
        <div className="alert-count-card">
          <span className="card-label">Open</span>
          <span className={`card-value ${openCount > 0 ? 'critical' : ''}`}>{openCount}</span>
        </div>
        <div className="alert-count-card">
          <span className="card-label">Acknowledged</span>
          <span className={`card-value ${ackedCount > 0 ? 'warning' : ''}`}>{ackedCount}</span>
        </div>
        <div className="alert-count-card">
          <span className="card-label">Resolved</span>
          <span className="card-value">{resolvedCount}</span>
        </div>
      </div>

      {total > 0 && (
        <div className="alert-severity-breakdown">
          {['CRITICAL', 'WARNING', 'INFO'].map(sev => {
            const count = bySeverity[sev] ?? 0;
            const colors = severityColors[sev] ?? severityColors.INFO;
            return count > 0 ? (
              <div
                key={sev}
                className="severity-item"
                style={
                  {
                    borderLeft: `3px solid ${colors.border}`,
                  } as React.CSSProperties
                }
              >
                <span className="severity-label">{sev}</span>
                <span className="severity-count">{count}</span>
              </div>
            ) : null;
          })}
        </div>
      )}
    </section>
  );
}
