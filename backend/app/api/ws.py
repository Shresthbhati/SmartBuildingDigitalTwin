"""`/ws/events`: live event stream.

Every message is `{seq, type, ts, data}` with type in reading|alert|anomaly|health and a
globally increasing `seq`. The first message after connecting is a `health` event carrying
`hello: true` and the current seq, so the client knows its baseline; any later jump in seq
means missed events and the client must resync over REST. A periodic `health` event doubles
as a heartbeat so clients can detect a dead connection.
"""

import asyncio
import logging
from app.core.config import settings
from app.core.events import bus
from app.services.mqtt_service import mqtt_service
from app.services.simulator_service import sensor_simulator
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter()

HEALTH_INTERVAL_S = 10


def health_snapshot() -> dict:
    return {
        "mqtt": "connected"
        if mqtt_service.connected
        else ("bypassed" if settings.simulator.transport == "direct" else "disconnected"),
        "simulator": "running" if sensor_simulator.running else "stopped",
        "ws_clients": bus.subscriber_count,
    }


async def health_publisher() -> None:
    """Publish a health event every few seconds while at least one client is listening."""
    while True:
        await asyncio.sleep(HEALTH_INTERVAL_S)
        if bus.subscriber_count:
            bus.publish("health", health_snapshot())


@router.websocket("/ws/events")
async def events_socket(ws: WebSocket) -> None:
    await ws.accept()
    sub = bus.subscribe()
    # Watch both directions: waiting only on the queue would never notice a client that
    # went away (the server would hold the subscription until the next send failed).
    recv = asyncio.create_task(ws.receive())
    get = asyncio.create_task(sub.get())
    try:
        # Subscribe first, then announce the baseline, so nothing slips between the two.
        await ws.send_json(
            {
                "seq": bus.seq,
                "type": "health",
                "ts": None,
                "data": {**health_snapshot(), "hello": True},
            }
        )
        while True:
            done, _ = await asyncio.wait({recv, get}, return_when=asyncio.FIRST_COMPLETED)
            if recv in done:
                if recv.result()["type"] == "websocket.disconnect":
                    return
                recv = asyncio.create_task(ws.receive())  # ignore client chatter
            if get in done:
                if sub.overflowed:
                    # Too slow to keep up: drop the connection so the client resyncs over REST.
                    await ws.close(code=1013)
                    return
                await ws.send_json(get.result())
                get = asyncio.create_task(sub.get())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        recv.cancel()
        get.cancel()
        bus.unsubscribe(sub)
