import { useEffect } from 'react';
import { WS_URL } from '../api/client';
import { useNexus } from '../store';
import { RealtimeClient } from './socket';

const POLL_INTERVAL_MS = 5000;

/**
 * Boots the app's data (REST bootstrap), keeps it live over the WebSocket, and falls back to
 * polling the same REST snapshot whenever the socket is not live, so the UI never goes blind.
 */
export function useRealtime(): void {
  useEffect(() => {
    const store = useNexus.getState();
    void store.bootstrap();

    const client = new RealtimeClient({
      url: WS_URL,
      onEvent: env => useNexus.getState().applyEvent(env),
      onState: (state, info) => useNexus.getState().setConnection(state, info),
      // Missed events (gap) or a reconnect: the REST snapshot is the source of truth.
      onResync: () => void useNexus.getState().loadSnapshot(true),
    });
    client.start();
    return () => client.stop();
  }, []);

  const state = useNexus(s => s.connection.state);
  useEffect(() => {
    if (state === 'live' || state === 'connecting') return;
    const id = window.setInterval(
      () => void useNexus.getState().loadSnapshot(true),
      POLL_INTERVAL_MS
    );
    return () => window.clearInterval(id);
  }, [state]);
}
