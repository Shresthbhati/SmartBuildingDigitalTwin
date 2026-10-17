import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AlertSummary } from './AlertSummary';

describe('AlertSummary', () => {
  it('renders without counts without error', () => {
    render(<AlertSummary counts={null} onAlertsClick={() => {}} />);
    expect(screen.getByText('Active Alerts')).toBeDefined();
    expect(screen.getByText('Open')).toBeDefined();
    expect(screen.getByText('Acknowledged')).toBeDefined();
    expect(screen.getByText('Resolved')).toBeDefined();
  });

  it('renders severity counts and open count', () => {
    const counts = {
      total: 5,
      by_severity: [
        { severity: 'CRITICAL', count: 2 },
        { severity: 'WARNING', count: 2 },
        { severity: 'INFO', count: 1 },
      ],
      by_status: [
        { status: 'OPEN', count: 3 },
        { status: 'ACKNOWLEDGED', count: 1 },
        { status: 'RESOLVED', count: 1 },
      ],
    };
    render(<AlertSummary counts={counts} onAlertsClick={() => {}} />);
    expect(screen.getByText('Active Alerts')).toBeDefined();
    expect(screen.getByText('5')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
    expect(screen.getByText('CRITICAL')).toBeDefined();
    expect(screen.getByText('WARNING')).toBeDefined();
    expect(screen.getByText('INFO')).toBeDefined();
  });
});
