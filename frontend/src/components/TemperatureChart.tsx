import type { SensorReading, AggregateBucket } from '../types';

interface TemperatureChartProps {
  readings?: SensorReading[];
  aggregate?: AggregateBucket[];
  room: string;
  useAggregate?: boolean;
}

export function TemperatureChart({
  readings = [],
  aggregate = [],
  room,
  useAggregate = false,
}: TemperatureChartProps) {
  const data = useAggregate ? aggregate : readings;

  if (data.length === 0) {
    return (
      <div className="temperature-chart">
        <h3>{room.toUpperCase()} - Temperature History</h3>
        <div className="chart-empty">No data available</div>
      </div>
    );
  }

  const width = 400;
  const height = 200;
  const padding = 40;

  // Extract values for scaling
  const values: number[] = useAggregate
    ? aggregate.map(b => b.avg_value ?? 0).filter(v => v !== null)
    : readings.map(r => r.value);
  if (values.length === 0) {
    return (
      <div className="temperature-chart">
        <h3>{room.toUpperCase()} - Temperature History</h3>
        <div className="chart-empty">No data available</div>
      </div>
    );
  }

  const minTemp = Math.min(...values) - 2;
  const maxTemp = Math.max(...values) + 2;

  const xScale = (i: number) => padding + (i / (data.length - 1 || 1)) * (width - 2 * padding);
  const yScale = (temp: number) =>
    height - padding - ((temp - minTemp) / (maxTemp - minTemp)) * (height - 2 * padding);

  let points: string;
  let statusColor = '#4ade80'; // default green

  if (useAggregate) {
    points = aggregate
      .map((b, i) => {
        const val = b.avg_value ?? b.min_value ?? b.max_value ?? 0;
        return `${xScale(i)},${yScale(val)}`;
      })
      .join(' ');

    // Determine color from latest aggregate
    const latest = aggregate[aggregate.length - 1];
    const latestVal = latest.avg_value ?? latest.min_value ?? latest.max_value ?? 0;
    if (latestVal > 35) statusColor = '#ef4444';
    else if (latestVal > 30) statusColor = '#f59e0b';
  } else {
    points = readings.map((r, i) => `${xScale(i)},${yScale(r.value)}`).join(' ');

    const latestVal = readings[readings.length - 1]?.value ?? 0;
    if (latestVal > 35) statusColor = '#ef4444';
    else if (latestVal > 30) statusColor = '#f59e0b';
  }

  return (
    <div className="temperature-chart">
      <h3>
        {room.toUpperCase()} - Temperature History {useAggregate && '(Aggregated)'}
      </h3>
      <svg width={width} height={height} className="chart-svg">
        <defs>
          <linearGradient id="temp-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={statusColor} stopOpacity="0.3" />
            <stop offset="100%" stopColor={statusColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect
          x={padding}
          y={padding}
          width={width - 2 * padding}
          height={height - 2 * padding}
          fill="none"
          stroke="#1e293b"
          strokeWidth="1"
        />
        <polyline fill="none" stroke={statusColor} strokeWidth="2" points={points} />
        <polyline
          fill="url(#temp-gradient)"
          stroke="none"
          points={`${padding},${height - padding} ${points} ${width - padding},${height - padding}`}
        />
        {data.map((d, i) => {
          const val = useAggregate
            ? ((d as AggregateBucket).avg_value ?? 0)
            : (d as SensorReading).value;
          return (
            <circle
              key={i}
              cx={xScale(i)}
              cy={yScale(val)}
              r={4}
              fill={statusColor}
              stroke="#0f172a"
              strokeWidth="2"
            />
          );
        })}
      </svg>
      <div className="chart-labels">
        <span>Min: {minTemp.toFixed(1)}°C</span>
        <span>Max: {maxTemp.toFixed(1)}°C</span>
        <span>Latest: {values[values.length - 1].toFixed(1)}°C</span>
      </div>
    </div>
  );
}
