import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { authApi } from '../api/client';
import { Inspector } from '../inspector/Inspector';
import { parseDeepLink, serializeDeepLink } from '../lib/deeplink';
import { useCan } from '../lib/useAuth';
import { useNow } from '../lib/useNow';
import { useRealtime } from '../realtime/useRealtime';
import { ModeSourceBadge } from '../state/StateViews';
import { useNexus, type Mode } from '../store';
import { EventTimeline } from '../timeline/EventTimeline';
import { LoginDialog } from './LoginDialog';

const NAV: {
  mode: Mode;
  path: string;
  label: string;
  icon: string;
  inspector: boolean;
  timeline: boolean;
}[] = [
  {
    mode: 'observe',
    path: '/observe',
    label: 'Observe',
    icon: '◉',
    inspector: true,
    timeline: true,
  },
  {
    mode: 'investigate',
    path: '/investigate',
    label: 'Investigate',
    icon: '⌕',
    inspector: true,
    timeline: true,
  },
  {
    mode: 'anticipate',
    path: '/anticipate',
    label: 'Anticipate',
    icon: '≈',
    inspector: true,
    timeline: false,
  },
  {
    mode: 'experiment',
    path: '/experiment',
    label: 'Experiment',
    icon: '⚗',
    inspector: false,
    timeline: false,
  },
  {
    mode: 'system',
    path: '/system',
    label: 'System',
    icon: '⚙',
    inspector: false,
    timeline: false,
  },
];

/** Keeps `?floor=&room=&sensor=&t=` and the store in sync, both ways. */
function useDeepLinkSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const selection = useNexus(s => s.selection);
  const cursor = useNexus(s => s.cursor);
  const playing = useNexus(s => s.playback.playing);

  // URL -> store, once.
  useEffect(() => {
    const link = parseDeepLink(location.search);
    const st = useNexus.getState();
    if (link.floor !== null || link.room || link.sensor) {
      st.select({ floor: link.floor, room: link.room, sensor: link.sensor });
      if (link.room) st.requestFocus({ room: link.room });
    }
    if (link.t !== 'live') void st.setCursor(link.t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // store -> URL (not while playing back: the cursor moves ten times a second).
  const here = useRef({ pathname: location.pathname, search: location.search });
  useEffect(() => {
    here.current = { pathname: location.pathname, search: location.search };
  });
  useEffect(() => {
    if (playing) return;
    // Debounced, and everything is read when it fires: a click that both selects something and
    // navigates (e.g. "Investigate") updates the store immediately but the router commits the
    // navigation a moment later, so writing straight away would put the old path back.
    const id = window.setTimeout(() => {
      const st = useNexus.getState();
      const next = serializeDeepLink({
        floor: st.selection.floor,
        room: st.selection.room,
        sensor: st.selection.sensor,
        t: st.cursor,
      });
      if (next !== here.current.search)
        navigate({ pathname: here.current.pathname, search: next }, { replace: true });
    }, 150);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.floor, selection.room, selection.sensor, cursor, playing, location.pathname]);
}

function ConnectionPill() {
  const c = useNexus(s => s.connection);
  const now = useNow(1000);
  const view = {
    live: { icon: '●', label: 'Live', cls: 'live', hint: 'Real-time updates over WebSocket' },
    connecting: { icon: '◌', label: 'Connecting', cls: 'wait', hint: 'Opening the live stream' },
    reconnecting: {
      icon: '↻',
      label: 'Reconnecting',
      cls: 'wait',
      hint: 'Live stream interrupted; refreshing every 5 s meanwhile',
    },
    offline: {
      icon: '✕',
      label: 'Offline · polling',
      cls: 'down',
      hint: 'Live stream unavailable; falling back to polling every 5 s',
    },
  }[c.state];
  return (
    <span
      className={`conn-pill ${view.cls}`}
      title={view.hint}
      role="status"
      data-testid="connection-state"
      data-state={c.state}
    >
      <span aria-hidden="true">{view.icon}</span> {view.label}
      {c.state !== 'live' && c.retryInMs !== null && (
        <span className="dim"> · retry {Math.ceil(c.retryInMs / 1000)}s</span>
      )}
      {c.state === 'live' && c.lastEventAt !== null && (
        <span className="dim"> · {Math.max(0, Math.round((now - c.lastEventAt) / 1000))}s</span>
      )}
    </span>
  );
}

function AuthChip() {
  const { session, authEnabled, promptLogin } = useCan();
  if (!authEnabled) return <span className="chip dim">Auth off (dev)</span>;
  return session ? (
    <span className="auth-chip">
      <span title={`Role: ${session.role}`}>
        {session.username} <span className="dim">({session.role})</span>
      </span>
      <button type="button" className="btn small" onClick={() => authApi.logout()}>
        Sign out
      </button>
    </span>
  ) : (
    <button type="button" className="btn small" onClick={promptLogin}>
      Sign in
    </button>
  );
}

function ModeBadge() {
  const mode = useNexus(s => s.mode);
  const cursor = useNexus(s => s.cursor);
  const sources = useNexus(s => {
    const set = new Set(Object.values(s.latest).map(r => r.source));
    return [...set].sort().join(',');
  });
  const label = NAV.find(n => n.mode === mode)?.label ?? 'Observe';
  const source: 'live' | 'time-travel' | 'scenario' | 'estimated' =
    cursor !== 'live'
      ? 'time-travel'
      : mode === 'experiment'
        ? 'scenario'
        : mode === 'anticipate'
          ? 'estimated'
          : 'live';
  const detail = sources.includes('scenario')
    ? 'Scenario-injected readings present'
    : sources.includes('simulated')
      ? 'Simulated sensors'
      : sources.includes('measured')
        ? 'Measured sensors'
        : undefined;
  return <ModeSourceBadge mode={label} source={source} detail={detail} />;
}

/** Layout route: one shell (and one realtime connection) shared by every mode. */
export function Shell() {
  useRealtime();
  useDeepLinkSync();
  const location = useLocation();
  const mode: Mode = NAV.find(n => location.pathname.startsWith(n.path))?.mode ?? 'observe';
  const setMode = useNexus(s => s.setMode);
  const inspectorOpen = useNexus(s => s.ui.inspectorOpen);
  const setUi = useNexus(s => s.setUi);
  const timelineOpen = useNexus(s => s.ui.timelineOpen);
  const nav = NAV.find(n => n.mode === mode)!;

  useEffect(() => setMode(mode), [mode, setMode]);

  return (
    <div
      className={`shell ${nav.inspector && inspectorOpen ? 'with-inspector' : ''} ${nav.timeline ? 'with-timeline' : ''} ${timelineOpen ? 'timeline-open' : ''}`}
    >
      <header className="topbar">
        <div className="brand" aria-label="NEXUS">
          <span className="brand-mark" aria-hidden="true">
            ◈
          </span>{' '}
          NEXUS
        </div>
        <ModeBadge />
        <div className="topbar-right">
          <ConnectionPill />
          <AuthChip />
        </div>
      </header>

      <nav className="navrail" aria-label="Modes">
        {NAV.map(n => (
          <NavLink
            key={n.path}
            to={{ pathname: n.path, search: location.search }}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <span className="nav-icon" aria-hidden="true">
              {n.icon}
            </span>
            <span className="nav-label">{n.label}</span>
          </NavLink>
        ))}
      </nav>

      <main className="viewport" id="main">
        <Outlet />
      </main>

      {nav.inspector && (
        <aside className={`inspector ${inspectorOpen ? 'open' : 'closed'}`} aria-label="Inspector">
          <button
            type="button"
            className="inspector-toggle"
            aria-expanded={inspectorOpen}
            aria-label={inspectorOpen ? 'Collapse inspector' : 'Expand inspector'}
            onClick={() => setUi({ inspectorOpen: !inspectorOpen })}
          >
            {inspectorOpen ? '›' : '‹'}
          </button>
          {inspectorOpen && (
            <div className="inspector-body">
              <Inspector />
            </div>
          )}
        </aside>
      )}

      {nav.timeline && <EventTimeline />}
      <LoginDialog />
    </div>
  );
}
