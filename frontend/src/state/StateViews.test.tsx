import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ModeSourceBadge,
  PartialNotice,
  PredictedBadge,
  SourceBadge,
  StaleBadge,
  StatusBadge,
} from './StateViews';

describe('state views', () => {
  it('loading announces itself politely', () => {
    render(<LoadingState label="Loading replay" />);
    expect(screen.getByRole('status').textContent).toContain('Loading replay');
  });

  it('empty explains what is empty and why it is fine', () => {
    render(<EmptyState title="No anomalies" hint="Nothing unusual right now." />);
    expect(screen.getByText('No anomalies')).toBeDefined();
    expect(screen.getByText('Nothing unusual right now.')).toBeDefined();
  });

  it('error is an alert with a working retry', () => {
    const retry = vi.fn();
    render(<ErrorState title="Couldn’t load" message="Network Error" onRetry={retry} />);
    expect(screen.getByRole('alert').textContent).toContain('Network Error');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('error without a retry handler shows no button', () => {
    render(<ErrorState message="x" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('partial names exactly what is missing, and renders nothing when nothing is', () => {
    const { container, rerender } = render(<PartialNotice missing={['alerts', 'anomalies']} />);
    expect(container.textContent).toContain('alerts, anomalies');
    rerender(<PartialNotice missing={[]} />);
    expect(container.textContent).toBe('');
  });
});

describe('badges carry text, not just colour', () => {
  it('status badge shows icon and label', () => {
    render(<StatusBadge state="critical" />);
    expect(screen.getByText('Critical')).toBeDefined();
    expect(screen.getByText('◆')).toBeDefined();
  });

  it('compact status badge keeps the label for screen readers', () => {
    render(<StatusBadge state="warning" compact />);
    expect(screen.getByText('Warning').className).toContain('sr-only');
  });

  it('stale badge says how long ago the sensor was last seen', () => {
    render(<StaleBadge lastSeenMs={1_000_000 - 3 * 60_000} nowMs={1_000_000} />);
    expect(screen.getByText(/Stale · last seen 3 min ago/)).toBeDefined();
  });

  it('stale badge for a sensor that never reported', () => {
    render(<StaleBadge lastSeenMs={null} />);
    expect(screen.getByText(/last seen never/)).toBeDefined();
  });

  it.each([
    ['simulated', 'Simulated'],
    ['scenario', 'Scenario-injected'],
    ['measured', 'Measured'],
  ] as const)('source badge labels %s data', (source, label) => {
    render(<SourceBadge source={source} />);
    expect(screen.getByText(label)).toBeDefined();
  });

  it('predicted badge says estimated by default and is customisable', () => {
    const { rerender } = render(<PredictedBadge />);
    expect(screen.getByText('Estimated')).toBeDefined();
    rerender(<PredictedBadge label="Rule-based (v1)" />);
    expect(screen.getByText('Rule-based (v1)')).toBeDefined();
  });
});

describe('ModeSourceBadge: the persistent "what am I looking at"', () => {
  it.each([
    ['live', 'LIVE'],
    ['time-travel', 'TIME TRAVEL'],
    ['scenario', 'SCENARIO · NOT LIVE'],
    ['estimated', 'ESTIMATED'],
    ['simulated', 'SIMULATED DATA'],
  ] as const)('%s mode is spelled out', (source, text) => {
    render(<ModeSourceBadge mode="Observe" source={source} detail="Simulated sensors" />);
    expect(screen.getByText(text)).toBeDefined();
    expect(screen.getByText('Simulated sensors')).toBeDefined();
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(`Observe mode, ${text}`);
  });
});
