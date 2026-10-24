# NEXUS — Architecture

What exists today. For where it is going see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md); for what is verified and what is not see [FEATURE_STATUS.md](FEATURE_STATUS.md). Rules that govern the design are in [VISION.md](VISION.md).

## System at a glance

```
                       MQTT (building/<location>/<measurement>)
  devices / simulator ───────────────────────────────┐
        │  (or in-process "direct" transport)        ▼
        └──────────────────────────────► mqtt_service.ingest()
                                                │ validate · idempotency · persist
                                                ▼
   ┌──────────── SQLite (WAL) ─────────────┐   alert_service / anomaly_service
   │ sensor_readings  room_status          │   (threshold rules · rolling z-score)
   │ alerts  anomaly_events                │            │ every status change
   │ lifecycle_events (append-only audit)  │◄───────────┘ writes an audit row
   │ buildings floors rooms assets sensors │
   │ scenario_runs                         │   after COMMIT only ──► EventBus ──► /ws/events
   └───────────────────────────────────────┘                                      │
        ▲ REST (FastAPI)                                                          ▼
        └────────────────────────────── React + three.js + zustand store ◄── RealtimeClient
```

* **Backend** `backend/app` — FastAPI, SQLAlchemy 2, Alembic, paho-mqtt, PyJWT.
* **Frontend** `frontend/src` — React 19, Vite, react-router, zustand, @react-three/fiber, GSAP.
* **Config** `config.yaml` (override path with `CONFIG_PATH`; secrets/URLs with env vars).

## Backend

### Canonical topology
`models/topology.py`: `Building → Floor → Room`, plus `Asset` (equipment on a floor, optionally in a room) and `Sensor` (in a room or on an asset). `config.yaml → topology:` is the source; `topology_service.seed_topology` upserts it at startup (structure and simulation parameters come from config, runtime state such as `last_seen_at` is preserved). Nothing derives IDs by string manipulation: `GET /api/topology` returns the tree, `GET /api/sensors` the flat list.

Telemetry's `room` field is a *location code*: a room code, or an asset code for meters (`meter-f0`).

### Ingestion
`mqtt_service.ingest(room, payload)` is the single entry point, used by the MQTT callback and by the simulator's in-process `direct` transport (no broker needed for development/CI). It is idempotent on `idempotency_key`, stamps `Sensor.last_seen_at` from the reading's *event* time, updates `room_status` for temperature only, and queues a `reading` event.

### Alerts vs anomalies (deliberately different things)
* **Alerts** (`alert_service`): fixed temperature thresholds with hysteresis, stale-sensor and invalid-reading detection; lifecycle OPEN → ACKNOWLEDGED → RESOLVED.
* **Anomalies** (`anomaly_service`): rolling per-sensor z-score. The baseline is computed from readings *before* the one being judged and flagged readings stay out of it. A moderate deviation must persist for `sustained_min_readings` before it is reported. Open anomalies are re-adopted from the DB after a restart.

### Lifecycle audit and events
`services/lifecycle.track_transition` appends a `lifecycle_events` row for every alert/anomaly transition (create, acknowledge, resolve, including automatic recovery by `system`) and queues a WebSocket event on the session. Queued events are published **after commit** and dropped on rollback, so a client that reacts to an event and re-reads over REST always sees the committed state.

### Real-time: `/ws/events`
`core/events.EventBus` is fed from worker threads and fans out to asyncio queues. Envelope: `{seq, type: reading|alert|anomaly|health, ts, data}`. The first message is a `health` event with `hello: true` and the current `seq` (the client's baseline); after that `seq` increases by exactly 1, so any jump is a detectable gap. A health event every 10 s doubles as a heartbeat. A slow consumer is disconnected (not silently starved) so it resyncs over REST.

### Replay (Building Time Travel)
`GET /api/replay?start&end&floor?` returns per-sensor points (raw below `max_points`, otherwise SQL-bucketed with `n` samples per point), the alerts/anomalies overlapping the window, and lifecycle events — from the audit table, with entities that predate it reconstructed from their stored timestamps and marked `source: "derived"`. Bounded by retention (30 d) and says so (`clamped_to_retention`, `truncated`). Gaps are returned as gaps.

### Investigation context
`GET /api/anomalies/{id}/context`: the sensor's room/floor/assets, alerts and anomalies within ±window, and events on sibling sensors, as nodes and edges. Edges are either `structural` (topology) or `temporal_cooccurrence` (timing). Nothing is called a cause.

### Scenario lab
`POST /api/scenarios/run` re-runs the seeded sensor model (`services/sim_model.py`, shared with the live simulator) twice in memory — baseline and modified — with identical noise so differences come only from the parameters. It never writes `sensor_readings`; only an explicit save writes `scenario_runs`. `POST /api/simulator/inject` (spike | drift | offline) makes the *live* simulator misbehave for demos/E2E; those readings carry `source=scenario`.

### Anticipate
`maintenance_service`: rule-based flags (anomaly frequency, alert recurrence, time in warning, flapping, stale) each with evidence links, labelled "rule-based (v1)"; a linear-trend forecast labelled "estimated" with a prediction band that abstains when data is stale or sparse; energy (kW vs kWh, peak, coverage) from the **simulated** meters.

### Auth
`core/security.py`: JWT (HS256) with roles viewer < operator < admin. Reads are open; every mutating endpoint requires a role; the actor recorded in the audit trail is the token's user. `auth.enabled: false` runs everything as an anonymous admin for local development. **Demo users and the default secret in `config.yaml` are dev-only.**

### Schema management
Alembic (`backend/alembic`, run at startup by `core/migrations.run_migrations`). The baseline migration creates any missing table, so databases created by the old `create_all` upgrade in place.

## Frontend

* **Store** (`src/store`): one normalized zustand store — topology, latest reading per sensor, alerts, anomalies, connection state, selection, mode, timeline cursor (`'live'` or epoch ms). Scene objects read it; they never call the API. Pure logic lives in `reducers.ts` and `replay.ts` and is unit tested.
* **Time travel**: `selectors.snapshotFor` resolves a sensor either live (streamed value) or at the cursor (`stateAt` over replayed points). In time travel it never falls back to the live value.
* **Realtime** (`src/realtime`): `RealtimeClient` — exponential backoff with jitter, stale-connection timeout, gap/reconnect detection → REST resync; `useRealtime` polls the REST snapshot every 5 s whenever the socket is not live.
* **3D** (`src/building`): geometry from topology; instanced sensor nodes; pulses only when a reading's counter changes; floor isolation; GSAP intro (skippable, skipped under `prefers-reduced-motion`); camera focus helper; energy flow only where a power sensor reports; labels are a DOM layer projected from the camera; keyboard-navigable table fallback (also used when WebGL is unavailable).
* **Modes/routes**: `/observe`, `/investigate`, `/anticipate`, `/experiment`, `/system`; deep links `?floor=&room=&sensor=&t=`.
* **Truthfulness in the UI**: every status has icon + label; data provenance badges (Simulated / Scenario-injected / Measured / Estimated); persistent mode/source badge; lifecycle actions show success only after the backend confirms.

## Running it

```bash
# backend (no broker needed)
cd backend && SIMULATOR_TRANSPORT=direct python -m uvicorn app.main:app --port 8000
# frontend
cd frontend && npm install && npm run dev
# or everything incl. Mosquitto
docker compose up
```

Tests: `cd backend && python -m pytest` · `cd frontend && npx tsc -b && npm test && npm run build` · E2E: `cd frontend && npm run e2e` (set `PW_CHANNEL=chrome` to use an installed Chrome).

## Legacy
`app.py`, `sensor.py` and `templates/` at the repo root are the original Flask prototype. They are unused by NEXUS and left in place for review.
