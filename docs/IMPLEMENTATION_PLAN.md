# NEXUS — Smart Building Digital Twin: Implementation Plan

## Context
Two documents define where the project is going. The Master Vision Doc covers product, UX, backend contracts and the truth-labelling rules. The NEXUS concept adds a 3D building as the main interface, four modes (Observe / Investigate / Anticipate / Experiment), Building Time Travel, a causal investigation graph and a scenario lab. The user asked to implement all of it and to start with a plan doc.

The plan builds on the current repo and does not replace it. Here is what the repo audit found.

**Already in place:**
- Backend: FastAPI + SQLAlchemy + SQLite (`backend/app`).
- MQTT ingestion with idempotency (`services/mqtt_service.py`).
- A seeded temperature simulator (`simulator_service.py`).
- Threshold alerts with hysteresis, stale detection and a lifecycle (`alert_service.py`).
- Rolling z-score anomalies with cooldown and recovery (`anomaly_service.py`).
- Retention (`retention_service.py`).
- An aggregate endpoint and history endpoints with `start`/`end`.
- Frontend: React 19 + Vite, with three, @react-three/fiber and drei already installed.
- A 3D scene exists: `src/building/BuildingScene.tsx`, `BuildingStructure.tsx`, `RoomMarker.tsx`, `RoomInspectionPanel.tsx`, `FloorSelector.tsx`, `state.ts`.
- Plain CSS variables in `src/index.css`.

**Not in place:**
- No Building, Floor, Room or Sensor tables. The layout comes from a grid formula in `/api/layout`.
- No WebSocket, no auth, no Alembic, no predictive maintenance.
- The frontend has no anomaly client.
- The frontend polls every 5 s with all state in `App.tsx`.
- Sensor IDs are derived by string hacks.
- 3D `lastUpdated` is faked to `new Date()`.
- `/api/alerts` has no time filter.
- History is capped and not paginated.
- Only temperature is measured, so there's no energy data.

**Known bugs:**
- Frontend `tsc` errors in `client.ts` and `App.tsx` (AlertFilter import, AlertSummary props, onAlertsClick signature).
- `AlertDetail` never opens.
- `metadata` vs `metadata_json` in the alert and anomaly response schemas.
- `pytest` is missing from `backend/requirements.txt`.

**Guiding rule from the vision:** every visual state maps to persisted backend data or is labelled *simulated / scenario / predicted*. Nothing is decorative and pretending to be data.

## Phase 0: Plan doc and stabilization
1. Copy this plan into the repo as `docs/IMPLEMENTATION_PLAN.md`. Store the two source documents as `docs/VISION.md` (master vision, condensed) and `docs/NEXUS_CONCEPT.md`.
2. Fix the frontend `tsc -b` errors (`src/api/client.ts`, `src/App.tsx`) and wire `setSelectedAlert` so `AlertDetail` opens.
3. Fix the `metadata` field in `backend/app/schemas` for alerts and anomalies. Use `validation_alias="metadata_json"` and add a regression test for `GET /api/alerts/{id}` and the anomaly equivalent.
4. Add `pytest` and `httpx` to the backend requirements.

## Phase 1: Canonical topology (one source of truth)
- New `backend/app/models/topology.py`:
  - `Building` (id, name, timezone)
  - `Floor` (building_id, level, name, elevation_m, height_m)
  - `Room` (floor_id, code, name, x, z, width, depth)
  - `Sensor` (room_id, sensor_id, type, unit, source, enabled, last_seen_at)
  - `Asset` (room_id, kind e.g. hvac/ahu/meter, name, x, z), for equipment the user can inspect
- A seed from a new `topology:` section in `config.yaml` that replaces the duplicated `simulation.rooms` and `simulator.sensors` room lists. The simulator reads sensors from the DB/topology.
- `/api/layout` returns DB records, so the grid formula goes away. Add `GET /api/topology` (the full tree) and `GET /api/sensors`.
- `mqtt_service` updates `Sensor.last_seen_at`. The frontend stops deriving `temp-sensor-${room}`.
- Add Alembic with a baseline migration. Replace `create_all` in `main.py` with `alembic upgrade head` at startup.

## Phase 2: Real-time event stream
- `GET /ws/events` WebSocket in a new `backend/app/api/ws.py`. A small `EventBus` (asyncio queue fan-out) is fed from the MQTT, alert and anomaly threads through `loop.call_soon_threadsafe`.
- Message envelope: `{seq, type: reading|alert|anomaly|health, ts, data}`. A monotonically increasing `seq` lets the client detect gaps.
- Frontend `src/realtime/socket.ts`: reconnect with exponential backoff and a stale-connection timeout. On a gap or reconnect it resyncs through REST. If the socket is down it falls back to the existing polling. The connection state is shown in the header.

## Phase 3: Frontend foundation (NEXUS shell)
- Dependencies: `zustand`, `react-router-dom`, `gsap`, `framer-motion`.
- Charts: keep extending the existing SVG `TemperatureChart`. Add a charting library only if synced cursors become painful.
- `src/store/`: a normalized store with topology, latest readings by sensor, alerts, anomalies, connection state, selected entity, mode, and the timeline cursor (`live` or a timestamp). Scene objects read from the store and never call the API themselves.
- Routes: `/observe`, `/investigate`, `/anticipate`, `/experiment`, `/system`. Deep links use `?floor=&room=&sensor=&t=`.
- Layout: left nav rail, central viewport, collapsible right inspector, expandable bottom timeline.
- Design tokens are redefined in `src/index.css`:
  - graphite background, electric cyan for telemetry, amber for warning, red for critical
  - neutral grey for stale/offline, violet for simulated/scenario
  - an Inter/JetBrains Mono type scale
- Status is never conveyed by colour alone; icons and labels always accompany it.
- Shared state components cover loading, empty, stale, partial, error, simulated and predicted. A persistent mode/source badge shows on every page.

## Phase 4: 3D living building (Observe)
Refactor `src/building/` into the five modules from the concept.
- **`BuildingScene`**:
  - floors and rooms come from the topology
  - GSAP intro (wireframe draws in, floors descend, sensors activate), about 3.5 s, skippable on click, skipped entirely under `prefers-reduced-motion`
  - floor isolation: other floors fade to translucent
  - camera focus helper
- **`TelemetryRenderer`**:
  - instanced sensor nodes and asset meshes
  - each value maps to a visual state through `state.ts` (normal/warn/critical/stale/offline/simulated)
  - pulses fire only when a new reading arrives, not continuously
  - stale state is driven by the real `last_seen_at`
- **Energy flow**: animated streams only where energy sensors exist. Add simulated `power_kw` meters per floor in the simulator, `source=simulated` and labelled as such, so the feature runs on real ingested data.
- **Accessibility fallback**: a keyboard-navigable table/list view of the same hierarchy.

## Phase 5: Anomaly investigation (Investigate)
- Frontend anomaly client and types for the existing `/api/anomalies*` endpoints.
- **`IntelligencePanel`** shows:
  - observed value, baseline/window, z-score and detector config
  - lifecycle actions (acknowledge/resolve) that wait for backend confirmation, with no optimistic success
- Evidence chart: source readings around `detected_at`, with the baseline band.
- Choreography: when a new anomaly arrives there's an amber outline, one localized pulse, an event marker and a "Focus camera" action. It stays identifiable with motion off.
- Threshold alerts and statistical anomalies are kept visually distinct.
- **Causal investigation graph**:
  - backend `GET /api/anomalies/{id}/context` returns the sensor, its room/floor/assets, alerts and anomalies in a ±window, and co-occurring events on sibling sensors
  - rendered as an SVG node-link graph
  - edges are labelled *structural* (topology) or *temporal co-occurrence*; nothing is ever called a "cause"

## Phase 6: Building Time Travel (signature feature)
- **Backend**:
  - add `start`/`end` to `/api/alerts`
  - new `GET /api/replay?start&end&floor?` returns readings (raw if under N points, otherwise aggregated buckets with `sample_count`), alerts and anomalies in the window
  - a lifecycle event list built from first-deviation / detected / acknowledged / resolved timestamps already stored on the models
  - paginated, with an explicit `truncated` flag
  - replay is bounded by retention (30 d); the UI says so
- New **`EventLifecycleEvent`** table (entity_type, entity_id, from_status, to_status, actor, at). Alert and anomaly services write a row on every transition, so the history is auditable and replay is exact.
- **Frontend `EventTimeline`**:
  - scrubber with event markers and play/pause/speed
  - the store's cursor drives the scene, inspector and charts together
  - the "state at T" for each sensor is the last reading at or before T within `stale_after`; otherwise it shows a gap
  - it's never filled in from the current snapshot
  - "Return to live" button

## Phase 7: Scenario lab (Experiment) and deterministic demo scenarios
- **Backend `services/scenario_service.py`**:
  - `POST /api/scenarios/run` with {sensor/floor, parameter (baseline offset, variation, power setpoint), window}
  - re-runs the seeded simulator model over the window twice, baseline and modified, entirely in memory
  - returns both series, the deltas and the exact assumptions
  - nothing goes into the live `SensorReading` table; saved runs go into a `ScenarioRun` table
- **Injectable live scenarios** for demos and E2E: `POST /api/simulator/inject` {sensor, kind: spike|drift|offline, duration}. Readings are tagged so the UI shows "scenario-injected".
- **Frontend `ScenarioWorkbench`**: parameter form validated against the config bounds, a split view (baseline vs scenario) with synced camera and charts, numbers always visible, and a persistent "Simulation — not a control action" banner.

## Phase 8: Anticipate (maintenance and energy intelligence)
- Rule-based maintenance flags in `services/maintenance_service.py`: anomaly frequency per sensor/asset over 7 days, alert recurrence, time-in-warning, sensor flapping/stale. `GET /api/maintenance` returns the evidence links.
- The output is labelled "rule-based (v1)". There's no ML and no failure-date prediction.
- **Forecast**: a short-horizon linear/EWMA trend per sensor, labelled "estimated", with an error band from recent residuals. It abstains when data is stale or sparse.
- **Energy page**: kW vs kWh, peak demand and coverage, all from the simulated meters and labelled simulated.

## Phase 9: Hardening, verification and truth docs
- **Auth**: simple JWT with roles Viewer, Operator and Admin (`core/security.py`). Required on every mutating endpoint (ack/resolve, retention run, simulator, scenarios). `actor` comes from the token.
- `/health/detailed` reports real `recent_errors` (ring buffer) and WS client count.
- **Backend tests**:
  - anomaly detector
  - topology seed
  - WS bus
  - replay windowing and gaps
  - lifecycle transitions and audit rows
  - scenario isolation (live table untouched)
  - an HTTP-level contract test through `TestClient`
- **Frontend tests**: vitest for the store reducers, replay "state at T", and the state components.
- **Playwright E2E golden loop** (Vision §19): health → topology loads → inject spike → anomaly appears in 3D and inspector → acknowledge/resolve → scrub timeline back to the event → refresh, history persists.
- Rewrite `docs/ARCHITECTURE.md` to match reality, and replace `docs/FEATURE_STATUS.md` with the Appendix B status ledger (Implemented-verified / unverified / simulated / planned).
- The legacy Flask `app.py`, `sensor.py` and `templates/` stay put. The judge decides whether to remove them.

## Order and parallelism
Phases 0 → 1 → 2 → 3 must go in order because everything later depends on them. After that, 4, 5 and 6 share the store and scene but can proceed in that order. 7 and 8 are independent backend-heavy slices. 9 runs throughout, with the final E2E last.

## Verification (per phase, and at the end)
- `cd backend && python -m pytest`, all green.
- `cd frontend && npm install && npx tsc -b && npm test && npm run build`, all clean.
- `docker compose up`, then open http://localhost:5173 in the browser pane and check:
  - the intro plays and is skippable
  - floor isolation works
  - live pulses arrive over WS (kill the backend and see reconnect/stale; restart and see recovery)
  - an injected spike produces an anomaly and the focus works
  - ack/resolve persists
  - timeline replay reconstructs the event with gaps shown
  - scenario split view shows the deltas
  - the reduced-motion and mobile widths are usable
- Run the Playwright golden loop.
- HawkScan pass after the auth/API work.

## Defaults chosen (flag if wrong)
- Single building. The schema supports more, but the UI doesn't expose a building switcher.
- Energy and power meters are simulated and clearly labelled.
- Predictive maintenance is rule-based plus a trend forecast; ML is out of scope.
- No physical control actions anywhere; the scenario lab is advisory simulation only.
