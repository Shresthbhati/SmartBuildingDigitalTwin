# NEXUS concept (condensed)

> **Provenance:** the original NEXUS concept document was not available in the repo when this was written. This is a condensed reconstruction from the [implementation plan](IMPLEMENTATION_PLAN.md). Replace it with the original text if you have it.

The 3D building is the primary interface. Four modes share one scene, one store and one timeline:

| Mode | Question | Surface |
|---|---|---|
| **Observe** | What is happening now? | Living 3D building, floor isolation, telemetry pulses, energy flow |
| **Investigate** | Why is this unusual? | Intelligence panel, evidence chart, causal investigation graph (structural + temporal co-occurrence edges only) |
| **Anticipate** | What needs attention soon? | Rule-based maintenance flags, "estimated" trend forecast, simulated energy |
| **Experiment** | What if…? | Scenario lab: baseline vs modified in-memory re-run, never written to live telemetry |

**Building Time Travel** — a bottom timeline scrubber with event markers. The store's cursor (`live` or a timestamp) drives scene, inspector and charts together. State at T is the last reading at or before T within `stale_after`, otherwise a gap.

**Five scene modules:** `BuildingScene` (topology, intro, floor isolation, camera), `TelemetryRenderer` (instanced sensor/asset nodes, pulses on new readings only), energy flow, accessibility fallback (keyboard-navigable table), and state mapping (`state.ts`).
