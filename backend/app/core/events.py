"""In-process event bus feeding the `/ws/events` WebSocket.

Producers are plain threads (MQTT callback, alert/anomaly workers); consumers are
asyncio queues owned by WebSocket handlers. `publish` is thread-safe and hands the
envelope to the event loop with `call_soon_threadsafe`. Each envelope carries a
monotonically increasing `seq` so clients can detect gaps and resync over REST.
"""

import asyncio
import threading
from datetime import UTC, datetime

EVENT_TYPES = ("reading", "alert", "anomaly", "health")


class Subscriber(asyncio.Queue):
    """Queue that remembers if it dropped events (slow consumer)."""

    def __init__(self, maxsize: int = 256):
        super().__init__(maxsize=maxsize)
        self.overflowed = False


class EventBus:
    def __init__(self):
        self._lock = threading.Lock()
        self._seq = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: set[Subscriber] = set()

    @property
    def seq(self) -> int:
        return self._seq

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def bind_loop(self, loop: asyncio.AbstractEventLoop | None) -> None:
        self._loop = loop

    def subscribe(self, maxsize: int = 256) -> Subscriber:
        sub = Subscriber(maxsize)
        self._subscribers.add(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subscribers.discard(sub)

    def publish(self, type_: str, data: dict, ts: datetime | None = None) -> dict:
        """Assign the next seq and fan the envelope out. Safe to call from any thread."""
        if type_ not in EVENT_TYPES:
            raise ValueError(f"Unknown event type: {type_}")
        # Scheduling happens under the lock so fan-out order always equals seq order.
        with self._lock:
            self._seq += 1
            envelope = {
                "seq": self._seq,
                "type": type_,
                "ts": (ts or datetime.now(UTC)).isoformat(),
                "data": data,
            }
            loop = self._loop
            if loop is not None and not loop.is_closed():
                loop.call_soon_threadsafe(self._fanout, envelope)
        return envelope

    def _fanout(self, envelope: dict) -> None:
        for sub in list(self._subscribers):
            if sub.overflowed:
                continue
            try:
                sub.put_nowait(envelope)
            except asyncio.QueueFull:
                # Slow consumer: stop feeding it; its handler closes the socket so the
                # client reconnects and resyncs via REST rather than silently missing events.
                sub.overflowed = True


bus = EventBus()
