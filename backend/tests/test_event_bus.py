import asyncio
import pytest
import threading
from app.api.ws import router as ws_router
from app.core.events import EventBus, bus
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_seq_is_gapless_and_monotonic_across_threads():
    b = EventBus()
    seen: list[int] = []
    lock = threading.Lock()

    def worker():
        for _ in range(100):
            seq = b.publish("reading", {})["seq"]
            with lock:
                seen.append(seq)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(seen) == list(range(1, 401))
    assert b.seq == 400


def test_envelope_shape_and_unknown_type():
    env = EventBus().publish("alert", {"id": 1})
    assert set(env) == {"seq", "type", "ts", "data"}
    assert env["type"] == "alert" and env["data"] == {"id": 1}
    with pytest.raises(ValueError):
        EventBus().publish("bogus", {})


@pytest.mark.asyncio
async def test_fanout_preserves_seq_order_from_other_threads():
    b = EventBus()
    b.bind_loop(asyncio.get_running_loop())
    sub = b.subscribe()

    def produce():
        for i in range(60):
            b.publish("reading", {"i": i})

    await asyncio.to_thread(produce)
    got = [await asyncio.wait_for(sub.get(), 1) for _ in range(60)]
    assert [g["seq"] for g in got] == list(range(1, 61))
    assert [g["data"]["i"] for g in got] == list(range(60))


@pytest.mark.asyncio
async def test_each_subscriber_gets_every_event_and_unsubscribe_stops_delivery():
    b = EventBus()
    b.bind_loop(asyncio.get_running_loop())
    a, c = b.subscribe(), b.subscribe()
    b.publish("health", {"n": 1})
    await asyncio.sleep(0)
    assert (await a.get())["data"] == (await c.get())["data"] == {"n": 1}
    b.unsubscribe(c)
    b.publish("health", {"n": 2})
    await asyncio.sleep(0)
    assert (await a.get())["data"] == {"n": 2}
    assert c.empty() and b.subscriber_count == 1


@pytest.mark.asyncio
async def test_slow_consumer_is_flagged_not_blocking():
    b = EventBus()
    b.bind_loop(asyncio.get_running_loop())
    slow = b.subscribe(maxsize=2)
    for i in range(5):
        b.publish("reading", {"i": i})
    await asyncio.sleep(0)
    assert slow.overflowed is True
    assert slow.qsize() == 2  # publisher was never blocked; the consumer must resync


def test_publish_without_loop_still_advances_seq():
    b = EventBus()  # e.g. unit tests or startup before the loop is bound
    assert b.publish("reading", {})["seq"] == 1
    assert b.seq == 1


def test_websocket_streams_hello_then_ordered_events():
    @asynccontextmanager
    async def lifespan(_app):
        bus.bind_loop(asyncio.get_running_loop())
        yield
        bus.bind_loop(None)

    app = FastAPI(lifespan=lifespan)
    app.include_router(ws_router)
    with TestClient(app) as client, client.websocket_connect("/ws/events") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "health" and hello["data"]["hello"] is True
        e1 = bus.publish("reading", {"sensor_id": "temp-sensor-101", "value": 23.1})
        e2 = bus.publish("alert", {"id": 7, "event": "created"})
        m1, m2 = ws.receive_json(), ws.receive_json()
        assert (m1["seq"], m2["seq"]) == (e1["seq"], e2["seq"])
        assert m2["seq"] == m1["seq"] + 1  # a client sees no gap when nothing was missed
        assert (m1["type"], m2["type"]) == ("reading", "alert")
        assert m1["data"]["value"] == 23.1
    assert bus.subscriber_count == 0
