import { useMemo } from 'react';
import { formatClock } from '../lib/format';

export interface ChartPoint {
  t: number; // epoch ms
  v: number;
}

export interface ChartSeries {
  id: string;
  label: string;
  color: string;
  points: ChartPoint[];
  dashed?: boolean;
}

export interface ChartBand {
  label: string;
  color: string;
  points: { t: number; lo: number; hi: number }[];
}

export interface ChartMarker {
  t: number;
  label: string;
  color: string;
}

export interface ChartGuide {
  v: number;
  label: string;
  color: string;
}

interface SeriesChartProps {
  series: ChartSeries[];
  bands?: ChartBand[];
  /** Horizontal reference lines (thresholds, baseline). */
  guides?: ChartGuide[];
  /** A flat band across the whole width (e.g. the detector's baseline range). */
  flatBand?: { lo: number; hi: number; label: string; color: string };
  markers?: ChartMarker[];
  cursorMs?: number | null;
  domain?: [number, number];
  unit?: string;
  height?: number;
  /** Break the line where consecutive points are further apart than this (a real gap). */
  gapMs?: number;
  ariaLabel: string;
  onScrub?: (ms: number) => void;
}

const W = 640;
const PAD = { l: 44, r: 12, t: 12, b: 24 };

export function SeriesChart({
  series,
  bands = [],
  guides = [],
  flatBand,
  markers = [],
  cursorMs = null,
  domain,
  unit = '',
  height = 200,
  gapMs,
  ariaLabel,
  onScrub,
}: SeriesChartProps) {
  const geom = useMemo(() => {
    const allT = [
      ...series.flatMap(s => s.points.map(p => p.t)),
      ...bands.flatMap(b => b.points.map(p => p.t)),
    ];
    const allV = [
      ...series.flatMap(s => s.points.map(p => p.v)),
      ...bands.flatMap(b => b.points.flatMap(p => [p.lo, p.hi])),
      ...guides.map(g => g.v),
      ...(flatBand ? [flatBand.lo, flatBand.hi] : []),
    ];
    if (allT.length === 0) return null;
    const [t0, t1] = domain ?? [Math.min(...allT), Math.max(...allT)];
    let v0 = Math.min(...allV);
    let v1 = Math.max(...allV);
    if (v0 === v1) {
      v0 -= 1;
      v1 += 1;
    }
    const pad = (v1 - v0) * 0.08;
    v0 -= pad;
    v1 += pad;
    const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v: number) => height - PAD.b - ((v - v0) / (v1 - v0)) * (height - PAD.t - PAD.b);
    return { t0, t1, v0, v1, x, y };
  }, [series, bands, guides, flatBand, domain, height]);

  if (!geom) {
    return (
      <div className="chart-empty" role="img" aria-label={ariaLabel}>
        No data in this window
      </div>
    );
  }
  const { t0, t1, v0, v1, x, y } = geom;

  const path = (pts: ChartPoint[]) => {
    let d = '';
    let prev: number | null = null;
    for (const p of pts) {
      const broken = prev === null || (gapMs !== undefined && p.t - prev > gapMs);
      d += `${broken ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)} `;
      prev = p.t;
    }
    return d;
  };

  const yTicks = Array.from({ length: 4 }, (_, i) => v0 + ((v1 - v0) * i) / 3);
  const xTicks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);

  const scrub = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!onScrub) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const ratio = (px - PAD.l) / (W - PAD.l - PAD.r);
    onScrub(Math.round(t0 + Math.min(1, Math.max(0, ratio)) * (t1 - t0)));
  };

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="none"
        style={{ width: '100%', height }}
        onPointerDown={onScrub ? scrub : undefined}
      >
        {yTicks.map(v => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" className="tick">
              {v.toFixed(1)}
            </text>
          </g>
        ))}
        {xTicks.map(t => (
          <text key={t} x={x(t)} y={height - 6} textAnchor="middle" className="tick">
            {formatClock(t, false)}
          </text>
        ))}

        {flatBand && (
          <rect
            x={PAD.l}
            width={W - PAD.l - PAD.r}
            y={y(flatBand.hi)}
            height={Math.max(1, y(flatBand.lo) - y(flatBand.hi))}
            fill={flatBand.color}
            opacity={0.14}
          >
            <title>{flatBand.label}</title>
          </rect>
        )}
        {bands.map(b => (
          <path
            key={b.label}
            d={
              b.points
                .map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.hi).toFixed(1)}`)
                .join(' ') +
              ' ' +
              [...b.points]
                .reverse()
                .map(p => `L${x(p.t).toFixed(1)},${y(p.lo).toFixed(1)}`)
                .join(' ') +
              ' Z'
            }
            fill={b.color}
            opacity={0.18}
          >
            <title>{b.label}</title>
          </path>
        ))}
        {guides.map(g => (
          <g key={g.label}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(g.v)}
              y2={y(g.v)}
              stroke={g.color}
              strokeDasharray="4 4"
              opacity={0.7}
            />
            <text x={W - PAD.r - 2} y={y(g.v) - 3} textAnchor="end" className="tick" fill={g.color}>
              {g.label}
            </text>
          </g>
        ))}
        {series.map(s => (
          <path
            key={s.id}
            d={path(s.points)}
            fill="none"
            stroke={s.color}
            strokeWidth={1.8}
            strokeDasharray={s.dashed ? '5 4' : undefined}
            strokeLinejoin="round"
          >
            <title>{s.label}</title>
          </path>
        ))}
        {markers.map(m => (
          <g key={`${m.t}-${m.label}`} transform={`translate(${x(m.t)},${height - PAD.b})`}>
            <path d="M0,0 L-4,-8 L4,-8 Z" fill={m.color}>
              <title>{m.label}</title>
            </path>
          </g>
        ))}
        {cursorMs !== null && cursorMs >= t0 && cursorMs <= t1 && (
          <line
            x1={x(cursorMs)}
            x2={x(cursorMs)}
            y1={PAD.t}
            y2={height - PAD.b}
            className="cursor"
          />
        )}
        {unit && (
          <text x={PAD.l} y={9} className="tick">
            {unit}
          </text>
        )}
      </svg>
      <figcaption className="chart-legend">
        {series.map(s => (
          <span key={s.id}>
            <i style={{ background: s.color }} aria-hidden="true" /> {s.label}
          </span>
        ))}
        {bands.map(b => (
          <span key={b.label}>
            <i style={{ background: b.color, opacity: 0.4 }} aria-hidden="true" /> {b.label}
          </span>
        ))}
        {flatBand && (
          <span>
            <i style={{ background: flatBand.color, opacity: 0.4 }} aria-hidden="true" />{' '}
            {flatBand.label}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
