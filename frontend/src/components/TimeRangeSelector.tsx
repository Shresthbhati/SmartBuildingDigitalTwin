import { useState, useMemo } from 'react';

interface TimeRangeSelectorProps {
  onRangeChange: (range: { start: string; end: string; interval: string }) => void;
  defaultRange?: { start: string; end: string; interval: string };
}

const INTERVALS = [
  { value: '1m', label: '1 minute' },
  { value: '5m', label: '5 minutes' },
  { value: '15m', label: '15 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '12h', label: '12 hours' },
  { value: '24h', label: '24 hours' },
];

const PRESETS = [
  { label: 'Last Hour', hours: 1, interval: '1m' },
  { label: 'Last 6 Hours', hours: 6, interval: '5m' },
  { label: 'Last 24 Hours', hours: 24, interval: '15m' },
  { label: 'Last 7 Days', hours: 168, interval: '1h' },
  { label: 'Last 30 Days', hours: 720, interval: '6h' },
];

function getISOString(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function getDefaultTimeRange() {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);
  return {
    start: getISOString(oneHourAgo),
    end: getISOString(now),
    interval: '15m',
  };
}

export function TimeRangeSelector({ onRangeChange, defaultRange }: TimeRangeSelectorProps) {
  const initialRange = useMemo(() => defaultRange || getDefaultTimeRange(), [defaultRange]);

  const [start, setStart] = useState(initialRange.start);
  const [end, setEnd] = useState(initialRange.end);
  const [interval, setInterval] = useState(initialRange.interval);

  function applyPreset(hours: number, intervalValue: string) {
    const now = new Date();
    const past = new Date(now.getTime() - hours * 3600000);
    setStart(getISOString(past));
    setEnd(getISOString(now));
    setInterval(intervalValue);
    onRangeChange({
      start: getISOString(past),
      end: getISOString(now),
      interval: intervalValue,
    });
  }

  function handleCustomChange() {
    onRangeChange({ start, end, interval });
  }

  return (
    <div className="time-range-selector">
      <div className="preset-buttons">
        {PRESETS.map(preset => (
          <button
            key={preset.label}
            className="preset-btn"
            onClick={() => applyPreset(preset.hours, preset.interval)}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="custom-range">
        <div className="range-input">
          <label>Start:</label>
          <input type="datetime-local" value={start} onChange={e => setStart(e.target.value)} />
        </div>
        <div className="range-input">
          <label>End:</label>
          <input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} />
        </div>
        <div className="range-input">
          <label>Interval:</label>
          <select value={interval} onChange={e => setInterval(e.target.value)}>
            {INTERVALS.map(i => (
              <option key={i.value} value={i.value}>
                {i.label}
              </option>
            ))}
          </select>
        </div>
        <button className="apply-btn" onClick={handleCustomChange}>
          Apply Custom Range
        </button>
      </div>
    </div>
  );
}
