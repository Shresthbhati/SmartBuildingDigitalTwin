import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../types/nexus';
import { CausalGraph, layoutGraph } from './CausalGraph';

const nodes: GraphNode[] = [
  {
    id: 'anomaly:42',
    kind: 'anomaly',
    label: 'Critical statistical spike in room204',
    focus: true,
  },
  { id: 'sensor:temp-sensor-204', kind: 'sensor', label: 'temp-sensor-204' },
  { id: 'room:room204', kind: 'room', label: 'Room 204' },
  { id: 'floor:1', kind: 'floor', label: 'Floor 1' },
  { id: 'alert:1', kind: 'alert', label: 'Critical temperature in room204' },
  { id: 'anomaly:43', kind: 'anomaly', label: 'Sustained deviation in room203' },
];

const edges: GraphEdge[] = [
  {
    id: 'e1',
    source: 'anomaly:42',
    target: 'sensor:temp-sensor-204',
    kind: 'structural',
    label: 'observed on',
  },
  {
    id: 'e2',
    source: 'sensor:temp-sensor-204',
    target: 'room:room204',
    kind: 'structural',
    label: 'located in',
  },
  { id: 'e3', source: 'room:room204', target: 'floor:1', kind: 'structural', label: 'on floor' },
  {
    id: 'e4',
    source: 'anomaly:42',
    target: 'alert:1',
    kind: 'temporal_cooccurrence',
    label: '+0s',
    delta_seconds: 0,
  },
  {
    id: 'e5',
    source: 'anomaly:42',
    target: 'anomaly:43',
    kind: 'temporal_cooccurrence',
    label: '-5s',
    delta_seconds: -5,
  },
];

describe('layoutGraph', () => {
  it('puts structure, sensors, the focus anomaly and nearby events in four columns', () => {
    const { placed } = layoutGraph(nodes);
    const x = (id: string) => placed.find(n => n.id === id)!.x;
    expect(x('room:room204')).toBe(x('floor:1'));
    expect(x('room:room204')).toBeLessThan(x('sensor:temp-sensor-204'));
    expect(x('sensor:temp-sensor-204')).toBeLessThan(x('anomaly:42'));
    expect(x('anomaly:42')).toBeLessThan(x('alert:1'));
    expect(x('alert:1')).toBe(x('anomaly:43'));
  });

  it('never overlaps nodes within a column', () => {
    const { placed } = layoutGraph(nodes);
    const byCol = new Map<number, number[]>();
    for (const n of placed) byCol.set(n.x, [...(byCol.get(n.x) ?? []), n.y]);
    for (const ys of byCol.values()) {
      const sorted = [...ys].sort((a, b) => a - b);
      sorted.slice(1).forEach((y, i) => expect(y - sorted[i]).toBeGreaterThanOrEqual(36));
    }
  });

  it('is deterministic', () => {
    expect(layoutGraph(nodes)).toEqual(layoutGraph(nodes));
  });
});

describe('CausalGraph', () => {
  it('draws every node as a focusable control with a text label', () => {
    render(
      <CausalGraph nodes={nodes} edges={edges} disclaimer="Co-occurrence is not causation." />
    );
    expect(screen.getAllByRole('button')).toHaveLength(nodes.length);
    expect(screen.getByLabelText('sensor: temp-sensor-204')).toBeDefined();
  });

  it('labels edges as structural or temporal, and never as a cause', () => {
    const { container } = render(
      <CausalGraph nodes={nodes} edges={edges} disclaimer="Co-occurrence is not causation." />
    );
    expect(container.querySelectorAll('.edge.structural')).toHaveLength(3);
    expect(container.querySelectorAll('.edge.temporal_cooccurrence')).toHaveLength(2);
    expect(screen.getByText(/Structural \(building topology\)/)).toBeDefined();
    expect(screen.getByText(/Temporal co-occurrence/)).toBeDefined();
    expect(screen.getByText('Co-occurrence is not causation.')).toBeDefined();
    expect(container.textContent?.toLowerCase()).not.toMatch(/caused by|root cause|because of/);
  });

  it('shows the timing offset on temporal edges', () => {
    render(<CausalGraph nodes={nodes} edges={edges} disclaimer="x" />);
    expect(screen.getByText('⏱ -5s')).toBeDefined();
  });

  it('skips edges whose endpoints are missing rather than crashing', () => {
    const bad: GraphEdge[] = [
      { id: 'x', source: 'nope', target: 'sensor:temp-sensor-204', kind: 'structural', label: 'l' },
    ];
    expect(() => render(<CausalGraph nodes={nodes} edges={bad} disclaimer="x" />)).not.toThrow();
  });
});
