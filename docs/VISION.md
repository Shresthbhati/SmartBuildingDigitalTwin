# Master Vision (condensed)

> **Provenance:** the original Master Vision Doc was not available in the repo when this was written. This file is a condensed reconstruction of the rules the [implementation plan](IMPLEMENTATION_PLAN.md) cites from it. Replace it with the original text if you have it.

## Product

A smart-building digital twin that operators can trust: a live, inspectable model of one building (floors → rooms → sensors/assets) driven by ingested telemetry, with alerts, statistical anomalies, replay of the past and clearly-labelled simulation of the future.

## Truth-labelling rules

1. Every visual state maps to persisted backend data, **or** is labelled `simulated`, `scenario`, or `predicted`.
2. Nothing is decorative while pretending to be data (no fake timestamps, no animated values without a source reading).
3. Missing data is shown as a **gap**, never filled from the current snapshot and never treated as zero.
4. Threshold alerts (rule-based) and statistical anomalies (baseline-based) are different things and are shown differently.
5. Temporal co-occurrence is never called a cause.
6. Lifecycle actions (acknowledge/resolve) show success only after backend confirmation.
7. Status is never conveyed by colour alone: icon + label always accompany it.
8. No physical control actions anywhere. Scenarios are advisory simulation.

## Backend contracts

* One canonical topology (Building → Floor → Room → Sensor/Asset) in the database; the frontend never derives IDs by string hacks.
* Telemetry ingestion is idempotent; events carry an event timestamp and ingestion timestamp.
* Real-time events use a sequence-numbered envelope so clients can detect gaps and resync via REST.
* Every alert/anomaly lifecycle transition is persisted as an auditable event.
* Replay is bounded by retention (30 days) and reports `truncated` explicitly.

## Golden loop (§19)

health → topology loads → inject spike → anomaly appears in 3D and inspector → acknowledge/resolve → scrub timeline back to the event → refresh, history persists.

## Appendix B — status ledger

Features are tracked as one of: **Implemented-verified**, **Implemented-unverified**, **Simulated**, **Planned**. See [FEATURE_STATUS.md](FEATURE_STATUS.md).
