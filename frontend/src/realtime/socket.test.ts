import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState, StreamEnvelope } from '../types/nexus';
import { backoffDelay, RealtimeClient, type Timers, type WebSocketLike } from './socket';

class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.onclose?.({});
  }
}

/** Manual clock: timers only fire when the test advances time. */
class FakeClock implements Timers {
  now = 0;
  private next = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => void this.timers.delete(h as number);
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
    }
    this.now = end;
  }
  get pending() {
    return this.timers.size;
  }
}

const hello = (seq: number) => ({
  seq,
  type: 'health',
  ts: null,
  data: { mqtt: 'ok', simulator: 'running', ws_clients: 1, hello: true },
});
const reading = (seq: number) => ({
  seq,
  type: 'reading',
  ts: null,
  data: {
    sensor_id: 's',
    room: 'r',
    measurement: 'temperature',
    value: 1,
    unit: 'celsius',
    source: 'simulated',
    event_timestamp: 't',
    room_status: null,
  },
});

let sockets: FakeSocket[];
let clock: FakeClock;
let events: StreamEnvelope[];
let states: { state: ConnectionState; attempt: number; retryInMs: number | null }[];
let resyncs: string[];

function make(opts: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
  const client = new RealtimeClient({
    url: 'ws://test/ws/events',
    onEvent: e => events.push(e),
    onState: (state, info) => states.push({ state, ...info }),
    onResync: r => resyncs.push(r),
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    timers: clock,
    random: () => 1, // no jitter: delay == ceiling
    ...opts,
  });
  return client;
}
const last = () => sockets[sockets.length - 1];

beforeEach(() => {
  sockets = [];
  clock = new FakeClock();
  events = [];
  states = [];
  resyncs = [];
});

describe('backoffDelay', () => {
  it('doubles up to the cap', () => {
    const d = (n: number) => backoffDelay(n, 1000, 30000, () => 1);
    expect([1, 2, 3, 4, 5, 6, 7].map(d)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
  it('jitters between 50% and 100% of the ceiling', () => {
    expect(backoffDelay(3, 1000, 30000, () => 0)).toBe(2000);
    expect(backoffDelay(3, 1000, 30000, () => 0.5)).toBe(3000);
  });
});

describe('RealtimeClient', () => {
  it('connects, adopts the hello seq as its baseline and goes live', () => {
    const c = make();
    c.start();
    expect(states[0].state).toBe('connecting');
    last().receive(hello(41));
    expect(states.at(-1)?.state).toBe('live');
    last().receive(reading(42));
    expect(events.map(e => e.seq)).toEqual([42]);
    expect(resyncs).toEqual([]);
  });

  it('detects a gap in seq and asks the app to resync', () => {
    make().start();
    last().receive(hello(10));
    last().receive(reading(11));
    last().receive(reading(14)); // 12 and 13 never arrived
    expect(resyncs).toEqual(['gap']);
    expect(events.map(e => e.seq)).toEqual([11, 14]); // the event itself is still delivered
    last().receive(reading(15));
    expect(resyncs).toEqual(['gap']); // no repeat once back in sequence
  });

  it('reconnects with exponential backoff and resyncs after recovering', () => {
    make({ offlineAfterFailures: 3 }).start();
    last().receive(hello(1));
    last().drop();
    expect(states.at(-1)).toMatchObject({ state: 'reconnecting', attempt: 1, retryInMs: 1000 });

    clock.advance(1000);
    expect(sockets).toHaveLength(2);
    last().drop(); // second attempt fails
    expect(states.at(-1)).toMatchObject({ state: 'reconnecting', attempt: 2, retryInMs: 2000 });

    clock.advance(1999);
    expect(sockets).toHaveLength(2); // not yet
    clock.advance(1);
    expect(sockets).toHaveLength(3);
    last().drop();
    expect(states.at(-1)).toMatchObject({ state: 'offline', attempt: 3, retryInMs: 4000 }); // polling takes over

    clock.advance(4000);
    last().receive(hello(99)); // backend is back (possibly restarted: seq reset is fine)
    expect(states.at(-1)?.state).toBe('live');
    expect(resyncs).toEqual(['reconnect']);
  });

  it('a first-ever connection does not trigger a reconnect resync', () => {
    make().start();
    last().receive(hello(5));
    expect(resyncs).toEqual([]);
  });

  it('resets the backoff after a successful connection', () => {
    make().start();
    last().drop();
    clock.advance(1000);
    last().drop();
    clock.advance(2000);
    last().receive(hello(1));
    last().drop();
    expect(states.at(-1)).toMatchObject({ attempt: 1, retryInMs: 1000 });
  });

  it('treats a silent connection as dead after the stale timeout and reconnects', () => {
    make({ staleAfterMs: 25_000 }).start();
    const first = last();
    first.receive(hello(1));
    clock.advance(24_000);
    expect(first.closed).toBe(false);
    clock.advance(1_001);
    expect(first.closed).toBe(true);
    expect(states.at(-1)?.state).toBe('reconnecting');
    clock.advance(1000);
    expect(sockets).toHaveLength(2);
  });

  it('any message re-arms the stale timer', () => {
    make({ staleAfterMs: 25_000 }).start();
    const s = last();
    s.receive(hello(1));
    for (let i = 2; i < 8; i++) {
      clock.advance(20_000);
      s.receive(reading(i));
    }
    expect(s.closed).toBe(false);
  });

  it('ignores garbage and messages from a replaced socket', () => {
    make().start();
    const first = last();
    first.onmessage?.({ data: 'not json' });
    first.receive({ nope: true });
    expect(events).toEqual([]);
    first.receive(hello(1));
    first.drop();
    clock.advance(1000);
    first.receive(reading(2)); // late delivery from the old socket
    expect(events).toEqual([]);
  });

  it('stop() closes the socket and cancels every timer', () => {
    const c = make();
    c.start();
    const s = last();
    s.receive(hello(1));
    c.stop();
    expect(s.closed).toBe(true);
    expect(clock.pending).toBe(0);
    clock.advance(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('survives a throwing socket factory by retrying', () => {
    const create = vi.fn(() => {
      throw new Error('boom');
    });
    make({ createSocket: create }).start();
    expect(states.at(-1)?.state).toBe('reconnecting');
    clock.advance(1000);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
