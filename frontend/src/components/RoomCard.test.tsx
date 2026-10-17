import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoomCard } from './RoomCard';

describe('RoomCard', () => {
  it('renders room name, temperature, and status', () => {
    render(<RoomCard data={{ room: 'room101', temperature: 22.5, status: 'NORMAL' }} />);
    expect(screen.getByText('ROOM101')).toBeDefined();
    expect(screen.getByText('22.5')).toBeDefined();
    expect(screen.getByText('NORMAL')).toBeDefined();
  });

  it('renders ALERT status', () => {
    render(<RoomCard data={{ room: 'room204', temperature: 37.0, status: 'ALERT' }} />);
    expect(screen.getByText('ROOM204')).toBeDefined();
    expect(screen.getByText('37.0')).toBeDefined();
    expect(screen.getByText('ALERT')).toBeDefined();
  });
});
