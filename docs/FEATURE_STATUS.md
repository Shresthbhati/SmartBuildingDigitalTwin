# Feature status ledger (Appendix B)

Every claim is one of:

* **Verified** — exercised and observed (automated test, or seen running).
* **Unverified** — implemented, not exercised in this environment. Do not assume it works.
* **Simulated** — works, but the data behind it is simulated, and the UI says so.
* **Planned** — not built.

"Verified by" names the evidence. Counts are from the last run on 2026-10-22.

## Platform

| Feature | Status | Verified by / note |
|---|---|---|
| Canonical topology in DB, seeded from `config.yaml`, idempotent | Verified | `test_topology.py`; fresh-DB startup observed |
| Alembic baseline migration at startup (also adopts pre-Alembic DBs) | Verified | fresh DB migrated and seeded on startup; upgrade of a legacy DB **not tested** |
| `/api/layout`, `/api/topology`, `/api/sensors`, `/api/readings/latest` | Verified | `test_contract.py` |
| MQTT ingestion with idempotency | Verified | `test_simulator.py` (via the shared ingest path) |
| MQTT *transport* through a real Mosquitto broker | Unverified | no broker available; only the in-process `direct` transport was run |
| `docker compose up` | Unverified | compose file validates; Docker daemon was not running. Fixed an empty-topology bug (config path) but not run |
| WebSocket `/ws/events` (envelope, seq, hello, ordering, slow consumer, disconnect cleanup) | Verified | `test_event_bus.py`; live stream observed in the browser |
| Events published only after commit, never after rollback | Verified | `test_lifecycle.py` |
| Lifecycle audit row on every alert/anomaly transition | Verified | `test_lifecycle.py` |
| JWT auth + roles on every mutating endpoint; actor from token | Verified | `test_contract.py` |
| Default secret / demo users | Unverified for production | **dev-only**; must be replaced before exposure |
| Statistical anomaly detector | Verified | `test_anomaly.py` (baseline excludes the point being judged, sustained-deviation streak, cooldown, recovery, restart re-adoption) |
| Threshold alerts with hysteresis, stale detection | Verified | `test_alerts.py` |
| Replay: windowing, raw vs aggregated, gaps, retention clamp, paging, derived vs audit events | Verified | `test_replay.py` |
| Anomaly investigation context (structural / temporal edges) | Verified | `test_contract.py`, `CausalGraph.test.tsx` |
| Scenario run is in-memory; live telemetry untouched; deterministic | Verified | `test_scenario.py` |
| Live injection (spike/drift/offline) tagged `scenario` | Verified | `test_simulator.py`; spike observed producing anomaly + alert in the UI |
| Maintenance flags, forecast (abstains), energy | Verified | `test_maintenance.py`; pages seen rendering |
| `/health/detailed` recent errors + WS client count | Verified | `test_contract.py` |
| HawkScan / DAST pass | **Unverified** | not run (no `HAWK_API_KEY`) |
| Legacy Flask `app.py`, `sensor.py`, `templates/` | Left in place | unused; remove at the reviewer's discretion |

## Frontend

| Feature | Status | Verified by / note |
|---|---|---|
| Typecheck, lint-clean build | Verified | `npx tsc -b`, `vite build` |
| Store reducers, replay "state at T", gap handling, lifecycle-without-optimism | Verified | `reducers.test.ts`, `replay.test.ts`, `store.test.ts` |
| Realtime client: backoff, stale timeout, gap + reconnect resync | Verified (unit) | `socket.test.ts` with a fake socket and clock |
| Kill the backend in a browser and watch reconnect → polling → recovery | **Unverified** | logic is unit-tested; not exercised end-to-end in a browser |
| Shared state components (loading/empty/error/partial/stale/source/predicted) | Verified | `StateViews.test.tsx` |
| Observe: 3D building from topology, labels, selection, inspector, history chart | Verified | seen running in the browser |
| 3D intro plays and is skippable | **Unverified** | the intro ran on load, skip-on-click not exercised; `prefers-reduced-motion` path not exercised |
| Floor isolation | **Unverified** | not exercised in the browser |
| Pulses only on new readings | Verified (unit) | counter logic in `reducers.test.ts`; the visual pulse was not inspected |
| Energy flow (simulated) | Simulated | seen rendering; labelled simulated |
| Accessible table view | Verified | `AccessibleBuilding` used by the E2E test |
| Investigate: lists, intelligence panel, evidence chart, graph | Verified | seen running against a real injected anomaly |
| Acknowledge / resolve with backend confirmation | Verified | E2E golden loop (see below) |
| Time travel: scrubber, markers, play/pause, return to live, deep link `t=` | Verified | seen scrubbing back 20 min; E2E |
| Experiment: form validation, split view, synced camera, deltas, banner | Verified | seen running; camera sync by eye only |
| Anticipate: flags, forecast, energy | Simulated | seen rendering; energy is simulated data |
| System page (health, injection form, operations) | Unverified | renders; form not submitted through the UI |
| Mobile (375 px) and tablet widths | Partial | Observe and Experiment seen at 375 px and usable; other pages not checked |
| Playwright golden loop | See "E2E" below | |

## E2E

Golden loop (health → topology → inject spike → anomaly in 3D and inspector → acknowledge/resolve → scrub to the event → refresh): `cd frontend && PW_CHANNEL=chrome npm run e2e`. **Passed** on 2026-10-22 (1 test, ~1.8 min, system Chrome, fresh database, includes the detector's ~75 s warm-up). Not covered: reconnect after killing the backend, the 3D intro skip, floor isolation, reduced motion.

## Simulated, by design

All sensor readings, the electrical meters and everything derived from them (energy, power flow) come from the built-in simulator and are labelled **Simulated** (or **Scenario-injected** for demo injections) wherever they appear. There is no ML, no failure-date prediction and no control action anywhere.

## Planned / out of scope

Multi-building switcher (schema supports it), ML-based predictive maintenance, any physical control, real device onboarding, production secrets management.
