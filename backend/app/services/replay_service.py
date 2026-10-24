"""Building Time Travel: everything needed to reconstruct the building over a time window.

Truth rules (see docs/VISION.md): replay is bounded by retention and says so; readings are
raw when the window is small and honestly aggregated (with sample counts) when it is not;
gaps stay gaps; lifecycle events come from the audit table, with a clearly-marked derived
fallback for entities that predate it.
"""

import math
from app.core.config import settings
from app.core.timeutil import as_utc, iso
from app.models.alert import Alert
from app.models.anomaly import AnomalyEvent
from app.models.lifecycle import EventLifecycleEvent
from app.models.sensor import SensorReading
from app.models.topology import Sensor
from app.services import timeseries
from datetime import UTC, datetime, timedelta
from sqlalchemy import or_
from sqlalchemy.orm import Session

ENTITY_CAP = 2000  # max alerts and max anomalies considered per replay window


def _val(x):
    return getattr(x, "value", x)


def _alert_summary(a: Alert) -> dict:
    return {
        "id": a.id,
        "room": a.room,
        "sensor_id": a.sensor_id,
        "type": _val(a.alert_type),
        "severity": _val(a.severity),
        "status": _val(a.status),
        "title": a.title,
        "started_at": iso(a.first_occurrence),
        "acknowledged_at": iso(a.acknowledged_at),
        "resolved_at": iso(a.resolved_at),
    }


def _anomaly_summary(a: AnomalyEvent) -> dict:
    return {
        "id": a.id,
        "room": a.room,
        "sensor_id": a.sensor_id,
        "type": _val(a.anomaly_category),
        "severity": _val(a.severity),
        "status": _val(a.status),
        "title": a.title,
        "started_at": iso(a.detected_at),
        "acknowledged_at": iso(a.acknowledged_at),
        "resolved_at": iso(a.resolved_at),
        "observed_value": a.observed_value,
        "expected_baseline": a.expected_baseline,
        "deviation_score": a.deviation_score,
    }


def _derived_events(entity_type: str, e, started_at, first_status="OPEN") -> list[dict]:
    """Transitions reconstructed from the timestamps stored on the model itself."""
    base = {
        "entity_type": entity_type,
        "entity_id": e.id,
        "room": e.room,
        "sensor_id": e.sensor_id,
        "severity": _val(e.severity),
        "title": e.title,
        "source": "derived",
    }
    out = [{**base, "at": started_at, "from": None, "to": first_status, "actor": None}]
    if e.acknowledged_at:
        out.append(
            {
                **base,
                "at": e.acknowledged_at,
                "from": "OPEN",
                "to": "ACKNOWLEDGED",
                "actor": e.acknowledged_by,
            }
        )
    if e.resolved_at:
        prev = "ACKNOWLEDGED" if e.acknowledged_at else "OPEN"
        out.append({**base, "at": e.resolved_at, "from": prev, "to": "RESOLVED", "actor": None})
    return out


def build_replay(
    db: Session,
    start: datetime,
    end: datetime,
    floor: int | None = None,
    max_points: int | None = None,
    event_limit: int | None = None,
    event_offset: int = 0,
) -> dict:
    cfg = settings.replay
    now = datetime.now(UTC)
    start, end = as_utc(start), as_utc(end)
    if end <= start:
        raise ValueError("end must be after start")

    retention_days = settings.retention.raw_telemetry_days
    retention_floor = now - timedelta(days=retention_days)
    clamped = start < retention_floor
    eff_start = max(start, retention_floor)
    if end <= eff_start:
        raise ValueError(f"Window is entirely outside the {retention_days}-day retention period")

    max_points = max(10, min(max_points or cfg.max_points_per_sensor, 5000))
    event_limit = max(1, min(event_limit or cfg.event_limit, 2000))
    event_offset = max(0, event_offset)
    span = (end - eff_start).total_seconds()
    bucket_seconds = max(1, math.ceil(span / max_points))

    sensors = db.query(Sensor).order_by(Sensor.sensor_id).all()
    if floor is not None:
        sensors = [s for s in sensors if s.floor_level == floor]
    locations = {s.location_code for s in sensors if s.location_code}

    sensor_out = []
    for s in sensors:
        base = db.query(SensorReading).filter(
            SensorReading.sensor_id == s.sensor_id,
            SensorReading.event_timestamp >= eff_start,
            SensorReading.event_timestamp <= end,
        )
        n = base.count()
        if n <= max_points:
            points = []
            for r in base.order_by(SensorReading.event_timestamp).all():
                p = {"t": iso(r.event_timestamp), "v": r.value, "n": 1}
                if _val(r.source) != "simulated":
                    p["s"] = _val(r.source)
                points.append(p)
            resolution = "raw"
        else:
            points = [
                {
                    "t": iso(b["t"]),
                    "v": round(b["avg"], 3),
                    "lo": b["lo"],
                    "hi": b["hi"],
                    "n": b["n"],
                }
                for b in timeseries.bucketed(db, s.sensor_id, eff_start, end, bucket_seconds)
            ]
            resolution = "aggregated"
        sensor_out.append(
            {
                "sensor_id": s.sensor_id,
                "location": s.location_code,
                "type": s.type,
                "unit": s.unit,
                "source": s.source,
                "floor": s.floor_level,
                "resolution": resolution,
                "sample_count": n,
                "points": points,
            }
        )

    # --- alerts / anomalies overlapping the window ------------------------------------
    def overlapping(model, started_col):
        q = db.query(model).filter(
            started_col <= end, or_(model.resolved_at.is_(None), model.resolved_at >= eff_start)
        )
        if floor is not None:
            q = q.filter(model.room.in_(locations or [""]))
        return q.order_by(started_col, model.id)

    alert_q = overlapping(Alert, Alert.first_occurrence)
    anomaly_q = overlapping(AnomalyEvent, AnomalyEvent.detected_at)
    # Entities are capped hard (never silently); `events` is what gets paginated.
    alerts = alert_q.limit(ENTITY_CAP + 1).all()
    anomalies = anomaly_q.limit(ENTITY_CAP + 1).all()
    entities_truncated = len(alerts) > ENTITY_CAP or len(anomalies) > ENTITY_CAP
    alerts, anomalies = alerts[:ENTITY_CAP], anomalies[:ENTITY_CAP]

    # --- lifecycle events -------------------------------------------------------------
    entities = {("alert", a.id): a for a in alerts} | {("anomaly", a.id): a for a in anomalies}
    audit_rows: list[EventLifecycleEvent] = []
    audited: set[tuple[str, int]] = set()
    for etype in ("alert", "anomaly"):
        ids = [i for (t, i) in entities if t == etype]
        if not ids:
            continue
        rows = (
            db.query(EventLifecycleEvent)
            .filter(
                EventLifecycleEvent.entity_type == etype, EventLifecycleEvent.entity_id.in_(ids)
            )
            .all()
        )
        audited |= {(r.entity_type, r.entity_id) for r in rows}
        audit_rows += rows

    events: list[dict] = []
    for r in audit_rows:
        ent = entities[(r.entity_type, r.entity_id)]
        events.append(
            {
                "at": as_utc(r.at),
                "entity_type": r.entity_type,
                "entity_id": r.entity_id,
                "from": r.from_status,
                "to": r.to_status,
                "actor": r.actor,
                "room": ent.room,
                "sensor_id": ent.sensor_id,
                "severity": _val(ent.severity),
                "title": ent.title,
                "source": "audit",
            }
        )
    for (etype, eid), ent in entities.items():
        if (etype, eid) in audited:
            continue
        started = ent.first_occurrence if etype == "alert" else ent.detected_at
        events += [{**d, "at": as_utc(d["at"])} for d in _derived_events(etype, ent, started)]

    events = [e for e in events if eff_start <= e["at"] <= end]
    events.sort(key=lambda e: (e["at"], e["entity_type"], e["entity_id"]))
    total_events = len(events)
    page = events[event_offset : event_offset + event_limit]
    for e in page:
        e["at"] = e["at"].isoformat()

    return {
        "start": eff_start.isoformat(),
        "end": end.isoformat(),
        "requested_start": start.isoformat(),
        "clamped_to_retention": clamped,
        "retention_days": retention_days,
        "retention_floor": retention_floor.isoformat(),
        "floor": floor,
        "max_points": max_points,
        "bucket_seconds": bucket_seconds,
        "stale_after_seconds": settings.alerts.stale_sensor_seconds,
        "sensors": sensor_out,
        "alerts": [_alert_summary(a) for a in alerts],
        "anomalies": [_anomaly_summary(a) for a in anomalies],
        "events": page,
        "event_total": total_events,
        "event_offset": event_offset,
        "event_limit": event_limit,
        "truncated": entities_truncated or total_events > event_offset + event_limit,
    }
