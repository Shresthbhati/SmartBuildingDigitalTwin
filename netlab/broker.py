"""Standalone MQTT 3.1.1 broker on a real TCP socket (amqtt), for running the NEXUS network
path without Docker/Mosquitto.  Usage: python broker.py [port]   (default 18830, loopback)."""

import asyncio
import logging
import sys

from amqtt.broker import Broker

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18830

CONFIG = {
    "listeners": {"default": {"type": "tcp", "bind": f"127.0.0.1:{PORT}"}},
    "sys_interval": 0,
    "auth": {"allow-anonymous": True},
    "topic-check": {"enabled": False},
}


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    broker = Broker(CONFIG)
    await broker.start()
    logging.getLogger("netlab.broker").info("broker listening on 127.0.0.1:%d", PORT)
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
