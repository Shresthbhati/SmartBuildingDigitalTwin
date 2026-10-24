import type { ConnectionState, StreamEnvelope } from '../types/nexus';

/** The slice of the browser WebSocket API the client needs (so tests can fake it). */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close: () => void;
}

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export type ResyncReason = 'gap' | 'reconnect';

export interface RealtimeOptions {
  url: string;
  onEvent: (envelope: StreamEnvelope) => void;
  onState: (state: ConnectionState, info: { attempt: number; retryInMs: number | null }) => void;
  /** Called when events may have been missed: refetch the truth over REST. */
  onResync: (reason: ResyncReason) => void;
  /** No message (the server sends a health event every ~10 s) for this long => dead link. */
  staleAfterMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** After this many consecutive failures the state becomes `offline` (UI falls back to polling). */
  offlineAfterFailures?: number;
  createSocket?: (url: string) => WebSocketLike;
  timers?: Timers;
  random?: () => number;
}

/** Exponential backoff with jitter: base * 2^(attempt-1), capped, then 50-100% of that. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/**
 * Client for `/ws/events`.
 *
 * Protocol (see backend/app/api/ws.py): the first message is a `health` event with
 * `hello: true` and the server's current seq; after that every message has seq = previous + 1.
 * Any other jump means events were missed, so the client asks the app to resync over REST.
 * A reconnect also triggers a resync, since anything published while we were away is gone.
 */
export class RealtimeClient {
  private readonly opts: Required<Omit<RealtimeOptions, 'createSocket' | 'timers' | 'random'>> & {
    createSocket: (url: string) => WebSocketLike;
    timers: Timers;
    random: () => number;
  };
  private socket: WebSocketLike | null = null;
  private attempt = 0;
  private lastSeq: number | null = null;
  private hasBeenLive = false;
  private stopped = true;
  private reconnectScheduled = false;
  private staleTimer: unknown = null;
  private reconnectTimer: unknown = null;

  constructor(options: RealtimeOptions) {
    this.opts = {
      staleAfterMs: 25_000,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      offlineAfterFailures: 3,
      createSocket: url => new WebSocket(url) as unknown as WebSocketLike,
      timers: {
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: handle => window.clearTimeout(handle as number),
      },
      random: Math.random,
      ...options,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.emit('connecting', null);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detach(socket);
      socket.close();
    }
  }

  // ------------------------------------------------------------------ internals
  private emit(state: ConnectionState, retryInMs: number | null): void {
    this.opts.onState(state, { attempt: this.attempt, retryInMs });
  }

  private open(): void {
    this.reconnectScheduled = false;
    let socket: WebSocketLike;
    try {
      socket = this.opts.createSocket(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.armStaleTimer();

    socket.onmessage = ev => this.handleMessage(socket, ev.data);
    socket.onclose = () => this.handleDrop(socket);
    socket.onerror = () => this.handleDrop(socket);
  }

  private handleMessage(socket: WebSocketLike, raw: unknown): void {
    if (socket !== this.socket) return; // late message from a socket we already replaced
    let envelope: StreamEnvelope;
    try {
      envelope = JSON.parse(String(raw)) as StreamEnvelope;
    } catch {
      return;
    }
    if (typeof envelope?.seq !== 'number' || !envelope.type) return;
    this.armStaleTimer();

    if (envelope.type === 'health' && envelope.data.hello) {
      // Fresh connection: adopt the server's seq as the baseline.
      const wasLive = this.hasBeenLive;
      this.attempt = 0;
      this.lastSeq = envelope.seq;
      this.hasBeenLive = true;
      this.emit('live', null);
      if (wasLive) this.opts.onResync('reconnect');
      return;
    }

    if (this.lastSeq !== null && envelope.seq !== this.lastSeq + 1) {
      this.opts.onResync('gap');
    }
    this.lastSeq = envelope.seq;
    this.opts.onEvent(envelope);
  }

  private handleDrop(socket: WebSocketLike): void {
    if (socket !== this.socket || this.stopped) return;
    this.socket = null;
    detach(socket);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    this.clearTimers();
    this.attempt += 1;
    const delay = backoffDelay(
      this.attempt,
      this.opts.baseDelayMs,
      this.opts.maxDelayMs,
      this.opts.random
    );
    this.emit(this.attempt >= this.opts.offlineAfterFailures ? 'offline' : 'reconnecting', delay);
    this.reconnectTimer = this.opts.timers.setTimeout(() => {
      if (!this.stopped) this.open();
    }, delay);
  }

  private armStaleTimer(): void {
    if (this.staleTimer !== null) this.opts.timers.clearTimeout(this.staleTimer);
    this.staleTimer = this.opts.timers.setTimeout(() => {
      // Connected but silent: treat as dead. Closing triggers the normal reconnect path.
      const socket = this.socket;
      if (!socket) return;
      this.handleDrop(socket);
      socket.close();
    }, this.opts.staleAfterMs);
  }

  private clearTimers(): void {
    if (this.staleTimer !== null) this.opts.timers.clearTimeout(this.staleTimer);
    if (this.reconnectTimer !== null) this.opts.timers.clearTimeout(this.reconnectTimer);
    this.staleTimer = this.reconnectTimer = null;
  }
}

function detach(socket: WebSocketLike): void {
  socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
}
