export function formatValue(value: number | null, unit: string, digits = 1): string {
  if (value === null || Number.isNaN(value)) return '—';
  const u = unit === 'celsius' ? '°C' : unit;
  return `${value.toFixed(digits)}${u === '°C' ? '' : ' '}${u}`;
}

export function formatClock(ms: number, withSeconds = true): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  });
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${formatClock(ms)}`;
}

/** "5s ago", "3 min ago", "2 h ago". `nowMs` is injectable so replay can render relative to T. */
export function relativeAge(thenMs: number | null, nowMs = Date.now()): string {
  if (thenMs === null) return 'never';
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = m / 60;
  if (h < 36) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${Math.round(h / 24)} d`;
}

export function categoryLabel(category: string): string {
  switch (category) {
    case 'z_score_spike':
      return 'Statistical spike';
    case 'z_score_drop':
      return 'Statistical drop';
    case 'sustained_deviation':
      return 'Sustained deviation';
    default:
      return category.replace(/_/g, ' ');
  }
}

export function alertTypeLabel(type: string): string {
  return type.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}
