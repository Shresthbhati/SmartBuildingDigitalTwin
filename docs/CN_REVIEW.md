# CN Mini Project: Review Pack

NEXUS Smart Building Digital Twin: a sensor network that publishes telemetry over MQTT to a backend, which stores it, detects faults and streams live state to a 3D web UI over WebSocket.

All measured numbers below come from `python netlab/evidence.py` (output in [`evidence/RESULTS.md`](evidence/RESULTS.md), raw data `evidence/results.json`, logs `evidence/*.log`). Re-run it to reproduce.

## Review 0: Problem understanding and design

**Problem.** Building sensors (temperature, power meters) must reach a monitoring system reliably over an unreliable network, tolerate broker/backend restarts without data corruption, and show live state to operators.

**Objectives.**
1. Sensors → broker → backend delivery with at-least-once semantics and no duplicate rows.
2. Survive broker crash, late broker start and malformed packets without manual intervention.
3. Push live updates to browsers with gap detection and automatic recovery.
4. Measure latency, throughput and loss.

**Architecture and protocols.**

| Hop | Protocol | Choice and reason |
|---|---|---|
| Sensor → broker | MQTT 3.1.1 over TCP, topic `building/<room>/<measurement>`, QoS 1 | Pub/sub decouples sensors from consumers; small header suits constrained devices; QoS 1 gives at-least-once delivery. |
| Broker → backend | MQTT subscription `building/+/+` | Wildcards mean new rooms/sensors need no backend change. |
| Payload | JSON (`sensor_id, room, measurement, value, unit, source, event_timestamp, idempotency_key`) | Self-describing; the idempotency key turns QoS 1 redelivery into exactly-once storage. Bare-float legacy payloads are still accepted. |
| Backend → browser | REST (history, actions) + WebSocket `/ws/events` | WebSocket for push; each event carries a sequence number so a client detects gaps and resyncs over REST. |

**Module breakdown** (see [ARCHITECTURE.md](ARCHITECTURE.md) for the diagram).

| Module | File |
|---|---|
| Sensor nodes (simulated) | `backend/app/services/simulator_service.py` |
| MQTT client / ingestion | `backend/app/services/mqtt_service.py` |
| Broker | Mosquitto (`docker-compose.yml`) or `netlab/broker.py` |
| Fault detection | `alert_service.py`, `anomaly_service.py` |
| Real-time fan-out | `core/events.py`, `api/ws.py` |
| UI client + reconnect logic | `frontend/src/realtime/` |

**Proof of concept.** `python netlab/broker.py` plus the backend with `SIMULATOR_TRANSPORT=mqtt MQTT_PORT=18830` is a working end-to-end network path with no Docker.

## Review 1: Implementation and intermediate demonstration

**Show actual communication.**
```
python netlab/broker.py                                                   # terminal 1: broker on :18830
cd backend && MQTT_PORT=18830 SIMULATOR_TRANSPORT=mqtt python -m uvicorn app.main:app   # terminal 2
python -c "import paho.mqtt.client as m;c=m.Client(m.CallbackAPIVersion.VERSION2);c.on_message=lambda *a:print(a[2].topic,a[2].payload);c.connect('127.0.0.1',18830);c.subscribe('building/#');c.loop_forever()"   # terminal 3: live wire tap
```
Sample real frames and logs: `evidence/results.json` (`s1.sample`), `evidence/broker.log`, `evidence/backend.log`.

**Normal operation (observed).** 10 sensors published; 30 frames seen on the wire, 30 rows stored; `/api/latest` returned the broker-delivered values.

**Failure and edge cases (observed).**

| Case | Result |
|---|---|
| Duplicate delivery (same idempotency key twice) | stored once |
| Malformed JSON / missing `value` | logged and dropped; backend stays healthy |
| Legacy bare-float payload | accepted |
| Broker killed for ~12 s | `/health` reports `mqtt: disconnected` within 0.02 s; 0 rows during outage; backend auto-reconnects 1.0 s after broker restart; data resumes 1.8 s later |
| Backend started before the broker | reports degraded, connects 2.3 s after broker appears, 37 rows in the next 12 s |

**Bug found and fixed by this testing.** With the broker absent at startup, the old code called blocking `client.connect()`, which raised before `loop_start()`, so the client never retried despite the log saying it would. Now `connect_async` + bounded backoff (1 to 10 s) in `mqtt_service.py` and `simulator_service.py`, with a capped offline queue (1000). Check 12 in `RESULTS.md` demonstrates the root cause. The post-fix behaviour is verified (checks 13 to 15); the pre-fix failure itself was not re-run end to end.

**Source / config / logs.** Source in `backend/`, config in `config.yaml` and `mosquitto/config/mosquitto.conf`, logs in `docs/evidence/`.

## Review 2: Validation, final demonstration, testing, viva

**Test cases and results.** 17/17 network checks in `evidence/RESULTS.md`; 161 backend tests (`cd backend && python -m pytest`); frontend unit tests and a Playwright golden loop (see [FEATURE_STATUS.md](FEATURE_STATUS.md)).

**Performance (single run, loopback, publishers → amqtt broker → subscriber).**

| QoS | msg/s | loss | p50 | p95 | p99 |
|---|---|---|---|---|---|
| 0 | 50 | 0 % | 20.1 ms | 39.4 ms | 40.4 ms |
| 1 | 50 | 0 % | 20.2 ms | 41.3 ms | 61.2 ms |
| 0 | 300 | 0 % | 6.4 ms | 13.7 ms | 23.7 ms |
| 1 | 300 | 0 % | 7.0 ms | 27.0 ms | 40.4 ms |
| 1 | 1000 | 0 % | 3.5 ms | 44.5 ms | 69.8 ms |

The building's real load is about 2 msg/s (10 sensors every 5 s), so there is large headroom. Run-to-run variance is significant (an earlier run had p95 = 201 ms at 1000 msg/s), so quote ranges, not single values.

**Why these choices (viva).**
- *MQTT over HTTP polling*: push, tiny headers, broker-side fan-out, built-in QoS and last-will support.
- *QoS 1 over QoS 0*: QoS 0 can silently lose frames on reconnect; the measured cost of QoS 1 here is a few ms at p95, and the idempotency key removes its duplicate downside. QoS 2 was not needed because storage is already idempotent.
- *Idempotency key over QoS 2*: one extra DB lookup instead of a 4-way handshake per message.
- *WebSocket with sequence numbers*: lets the browser detect a lost event and resync instead of silently showing stale state.

**Limitations.**
- Loopback only: no real WAN latency, jitter or packet loss; numbers show protocol and software overhead.
- Benchmark broker is pure-Python amqtt; Mosquitto (in `docker-compose.yml`) was not run (see Unverified in FEATURE_STATUS).
- Sensors are simulated; no physical hardware or constrained-device firmware.
- Broker allows anonymous, unencrypted connections: no TLS or per-device credentials.
- No MQTT last-will/retained "device online" status; staleness is inferred from missing readings.
- Readings published while the broker is down are not guaranteed to be delivered (bounded in-memory queue only, lost if the backend restarts). In the broker-crash run, 0 rows were stored during the outage.

**Possible improvements.** TLS + per-sensor credentials; last-will presence topics; retained last value per topic; persistent client sessions (`clean_session=False`) so the broker queues for a down backend; broker clustering/bridge; testing under injected loss with `tc netem` or Clumsy.

**Individual contributions.** To be filled by the team (names and modules) before submission.
