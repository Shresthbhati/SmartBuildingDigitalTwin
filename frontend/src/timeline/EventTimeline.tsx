import { useEffect } from 'react';
import { formatDateTime, formatDuration, relativeAge } from '../lib/format';
import { useNow } from '../lib/useNow';
import { ErrorState, LoadingState } from '../state/StateViews';
import { useNexus } from '../store';
import type { ReplayEvent } from '../types/nexus';

const WINDOWS = [
  { label: '15 min', ms: 15 * 60_000 },
  { label: '1 h', ms: 60 * 60_000 },
  { label: '6 h', ms: 6 * 3_600_000 },
  { label: '24 h', ms: 24 * 3_600_000 },
  { label: '7 d', ms: 7 * 86_400_000 },
];
const SPEEDS = [1, 10, 60, 300];
const TICK_MS = 100;

const STATUS_COLOR: Record<string, string> = {
  OPEN: '#fbbf24',
  ACKNOWLEDGED: '#22d3ee',
  RESOLVED: '#7b8494',
};

/**
 * Building Time Travel. Moving the scrubber sets the store's cursor; the scene, inspector and
 * charts all read the building "as of" that cursor from replayed data. "Return to live" drops it.
 */
export function EventTimeline() {
  const open = useNexus(s => s.ui.timelineOpen);
  const setUi = useNexus(s => s.setUi);
  const cursor = useNexus(s => s.cursor);
  const replay = useNexus(s => s.replay);
  const playback = useNexus(s => s.playback);
  const setPlayback = useNexus(s => s.setPlayback);
  const setCursor = useNexus(s => s.setCursor);
  const goLive = useNexus(s => s.goLive);
  const loadReplay = useNexus(s => s.loadReplay);
  const advance = useNexus(s => s.advance);
  const select = useNexus(s => s.select);
  const now = useNow(1000);

  // Load the replay window the first time the timeline is opened.
  useEffect(() => {
    if (open && replay.status === 'idle') void loadReplay();
  }, [open, replay.status, loadReplay]);

  // Playback clock.
  useEffect(() => {
    if (!playback.playing || cursor === 'live') return;
    const id = window.setInterval(() => advance(TICK_MS * playback.speed), TICK_MS);
    return () => window.clearInterval(id);
  }, [playback.playing, playback.speed, cursor, advance]);

  const { startMs, endMs, data } = replay;
  const span = Math.max(1, endMs - startMs);
  const value = cursor === 'live' ? endMs : cursor;
  const windowMs = endMs - startMs;
  const activeWindow = WINDOWS.find(w => Math.abs(w.ms - windowMs) < w.ms * 0.15 + 120_000);

  const focusEvent = (e: ReplayEvent) => {
    void setCursor(Date.parse(e.at));
    if (e.entity_type === 'anomaly')
      select({ room: e.room, anomalyId: e.entity_id, alertId: null });
    else select({ room: e.room, alertId: e.entity_id, anomalyId: null });
  };

  const play = () => {
    if (cursor === 'live') void setCursor(startMs).then(() => setPlayback({ playing: true }));
    else setPlayback({ playing: !playback.playing });
  };

  return (
    <section className={`timeline ${open ? 'open' : ''}`} aria-label="Building timeline">
      <div className="timeline-bar">
        <button
          type="button"
          className="btn small"
          aria-expanded={open}
          onClick={() => setUi({ timelineOpen: !open })}
        >
          {open ? '▾ Timeline' : '▴ Timeline'}
        </button>
        {cursor === 'live' ? (
          <span className="timeline-state live" role="status">
            <span aria-hidden="true">●</span> Live
          </span>
        ) : (
          <>
            <span className="timeline-state travel" role="status">
              <span aria-hidden="true">⏲</span> Viewing {formatDateTime(cursor)} ·{' '}
              {relativeAge(cursor, now)}
            </span>
            <button type="button" className="btn small primary" onClick={goLive}>
              Return to live
            </button>
          </>
        )}
        {!open && <span className="dim">Scrub the building back in time</span>}
      </div>

      {open && (
        <div className="timeline-body">
          {replay.status === 'loading' && !data && <LoadingState label="Loading replay" />}
          {replay.status === 'error' && (
            <ErrorState
              title="Couldn’t load the replay"
              message={replay.error}
              onRetry={() => void loadReplay()}
            />
          )}
          {data && (
            <>
              <div className="timeline-controls">
                <button
                  type="button"
                  className="btn"
                  onClick={play}
                  aria-pressed={playback.playing}
                >
                  {playback.playing && cursor !== 'live' ? '❚❚ Pause' : '▶ Play'}
                </button>
                <label>
                  Speed
                  <select
                    value={playback.speed}
                    onChange={e => setPlayback({ speed: Number(e.target.value) })}
                  >
                    {SPEEDS.map(s => (
                      <option key={s} value={s}>
                        {s}×
                      </option>
                    ))}
                  </select>
                </label>
                <div className="btn-group" role="group" aria-label="Window">
                  {WINDOWS.map(w => (
                    <button
                      key={w.label}
                      type="button"
                      className="btn small"
                      aria-pressed={activeWindow === w}
                      onClick={() => void loadReplay({ windowMs: w.ms })}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
                <span className="dim">{formatDuration(span)} window</span>
              </div>

              <div className="scrubber">
                <input
                  type="range"
                  min={startMs}
                  max={endMs}
                  step={1000}
                  value={value}
                  aria-label="Timeline position"
                  aria-valuetext={cursor === 'live' ? 'Live' : formatDateTime(cursor)}
                  onChange={e => {
                    setPlayback({ playing: false });
                    void setCursor(Number(e.target.value));
                  }}
                />
                <div className="markers" aria-hidden={false}>
                  {data.events.map((e, i) => {
                    const t = Date.parse(e.at);
                    return (
                      <button
                        key={`${e.entity_type}-${e.entity_id}-${i}`}
                        type="button"
                        className={`marker ${e.entity_type}`}
                        style={{
                          left: `${((t - startMs) / span) * 100}%`,
                          color: STATUS_COLOR[e.to] ?? '#fff',
                        }}
                        title={`${formatDateTime(t)} · ${e.entity_type} #${e.entity_id} ${e.from ?? 'created'} → ${e.to}`}
                        aria-label={`${e.entity_type} ${e.entity_id} ${e.to.toLowerCase()} at ${formatDateTime(t)}`}
                        onClick={() => focusEvent(e)}
                      >
                        {e.entity_type === 'anomaly' ? 'σ' : '▲'}
                      </button>
                    );
                  })}
                </div>
                <div className="scrubber-labels dim">
                  <span>{formatDateTime(startMs)}</span>
                  <span>now</span>
                </div>
              </div>

              <div className="timeline-notes dim">
                Replay covers the last {data.retention_days} days of retained data; older readings
                are deleted.
                {data.clamped_to_retention && ' The window was shortened to fit.'}
                {data.truncated &&
                  ` Showing ${data.events.length} of ${data.event_total} events.`}{' '}
                Sensors with no reading near the chosen moment show as gaps, never as a copy of the
                current value.
              </div>

              <div className="event-table-wrap">
                <table
                  className="data-table compact"
                  aria-label="Alert and anomaly lifecycle events in this window"
                >
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">Item</th>
                      <th scope="col">Change</th>
                      <th scope="col">By</th>
                      <th scope="col">Record</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.length === 0 && (
                      <tr>
                        <td colSpan={5} className="dim">
                          No alerts or anomalies in this window.
                        </td>
                      </tr>
                    )}
                    {[...data.events].reverse().map((e, i) => (
                      <tr
                        key={i}
                        tabIndex={0}
                        onClick={() => focusEvent(e)}
                        onKeyDown={ev => ev.key === 'Enter' && focusEvent(e)}
                      >
                        <td className="mono">{formatDateTime(Date.parse(e.at))}</td>
                        <td>
                          {e.entity_type === 'anomaly' ? 'σ Anomaly' : '▲ Alert'} · {e.room}
                        </td>
                        <td>
                          {e.from ?? 'created'} → {e.to}
                        </td>
                        <td>{e.actor ?? '—'}</td>
                        <td
                          className="dim"
                          title={
                            e.source === 'derived'
                              ? 'Reconstructed from stored timestamps; no audit row exists for this item'
                              : 'Recorded when it happened'
                          }
                        >
                          {e.source}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
