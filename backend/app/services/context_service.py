"""Investigation context for an anomaly: a node-link graph of what is *near* it.

Edges are only ever one of two kinds, and the UI labels them as such:
  structural            - the topology says these things are connected (sensor in room on floor)
  temporal_cooccurrence - these events happened within the same window
Nothing here claims causation.
"""

from app.core.config import settings
from app.core.timeutil import as_utc, iso
from app.models.alert import Alert
from app.models.anomaly import AnomalyEvent
from app.models.sensor import SensorReading
from app.schemas.common import parse_json_metadata
from app.services.topology_service import sensor_context
from datetime import timedelta
from sqlalchemy.orm import Session

DISCLAIMER = (
    "Edges show building structure or timing only. Co-occurrence is not causation: "
    "this view suggests where to look, it does not explain why."
)
MAX_EVIDENCE_POINTS = 400


def _val(x):
    return getattr(x, "value", x)


def build_anomaly_context(
    db: Session, anomaly_id: int, window_minutes: int | None = None
) -> dict | None:
    anomaly = db.get(AnomalyEvent, anomaly_id)
    if anomaly is None:
        return None

    window = timedelta(minutes=window_minutes or settings.replay.context_window_minutes)
    t0 = as_utc(anomaly.detected_at)
    lo, hi = t0 - window, t0 + window
    ctx = sensor_context(db, anomaly.sensor_id)

    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    def add_node(node_id: str, kind: str, label: str, **extra) -> None:
        nodes.setdefault(node_id, {"id": node_id, "kind": kind, "label": label, **extra})

    def add_edge(source: str, target: str, kind: str, label: str, **extra) -> None:
        edges.append(
            {
                "id": f"e{len(edges) + 1}",
                "source": source,
                "target": target,
                "kind": kind,
                "label": label,
                **extra,
            }
        )

    focus = f"anomaly:{anomaly.id}"
    add_node(
        focus,
        "anomaly",
        anomaly.title,
        status=_val(anomaly.status),
        severity=_val(anomaly.severity),
        at=iso(anomaly.detected_at),
        focus=True,
    )
    sensor_node = f"sensor:{anomaly.sensor_id}"
    add_node(sensor_node, "sensor", anomaly.sensor_id)
    add_edge(focus, sensor_node, "structural", "observed on")

    sibling_ids: set[str] = set()
    sibling_locations: set[str] = set()
    if ctx is not None:
        floor_node = f"floor:{ctx['floor']['level']}"
        add_node(floor_node, "floor", ctx["floor"]["name"])
        if ctx["room"]:
            room_node = f"room:{ctx['room']['code']}"
            add_node(room_node, "room", ctx["room"]["name"])
            add_edge(sensor_node, room_node, "structural", "located in")
            add_edge(room_node, floor_node, "structural", "on floor")
        for asset in ctx["assets"]:
            asset_node = f"asset:{asset['code']}"
            add_node(asset_node, "asset", f"{asset['name']} ({asset['kind']})")
            add_edge(asset_node, floor_node, "structural", "serves floor")
        for s in ctx["siblings"]:
            sibling_ids.add(s["sensor_id"])
            if s["location"]:
                sibling_locations.add(s["location"])

    # --- events in the window ---------------------------------------------------------
    def in_window(col):
        return (col >= lo) & (col <= hi)

    alerts = (
        db.query(Alert)
        .filter(in_window(Alert.first_occurrence))
        .filter(
            (Alert.sensor_id == anomaly.sensor_id)
            | (Alert.room == anomaly.room)
            | Alert.sensor_id.in_(sibling_ids)
            | Alert.room.in_(sibling_locations)
        )
        .order_by(Alert.first_occurrence)
        .limit(50)
        .all()
    )
    others = (
        db.query(AnomalyEvent)
        .filter(in_window(AnomalyEvent.detected_at), AnomalyEvent.id != anomaly.id)
        .filter(
            (AnomalyEvent.sensor_id == anomaly.sensor_id) | AnomalyEvent.sensor_id.in_(sibling_ids)
        )
        .order_by(AnomalyEvent.detected_at)
        .limit(50)
        .all()
    )

    def attach(node_id: str, kind: str, row, at, same_sensor: bool) -> None:
        delta = round((as_utc(at) - t0).total_seconds())
        add_node(
            node_id,
            kind,
            row.title,
            status=_val(row.status),
            severity=_val(row.severity),
            at=iso(at),
            sensor_id=row.sensor_id,
            room=row.room,
        )
        if not same_sensor and row.sensor_id and row.sensor_id != anomaly.sensor_id:
            owner = f"sensor:{row.sensor_id}"
            add_node(owner, "sensor", row.sensor_id, sibling=True)
            add_edge(node_id, owner, "structural", "observed on")
            if ctx is not None:
                add_edge(owner, f"floor:{ctx['floor']['level']}", "structural", "on floor")
        sign = "+" if delta >= 0 else ""
        add_edge(
            focus,
            node_id,
            "temporal_cooccurrence",
            f"{sign}{delta}s",
            delta_seconds=delta,
            same_sensor=same_sensor,
        )

    for a in alerts:
        attach(
            f"alert:{a.id}",
            "alert",
            a,
            a.first_occurrence,
            a.sensor_id == anomaly.sensor_id or a.room == anomaly.room,
        )
    for o in others:
        attach(f"anomaly:{o.id}", "anomaly", o, o.detected_at, o.sensor_id == anomaly.sensor_id)

    # --- evidence: the readings around detection + the baseline the detector used ------
    readings = (
        db.query(SensorReading)
        .filter(SensorReading.sensor_id == anomaly.sensor_id)
        .filter(in_window(SensorReading.event_timestamp))
        .order_by(SensorReading.event_timestamp)
        .limit(MAX_EVIDENCE_POINTS)
        .all()
    )
    meta = parse_json_metadata(anomaly.metadata_json) or {}
    mean, std = meta.get("rolling_mean"), meta.get("rolling_stddev")
    z_thr = (meta.get("detector_config") or {}).get(
        "z_score_threshold", settings.anomaly_detection.z_score_threshold
    )
    baseline = (
        {
            "mean": mean,
            "stddev": std,
            "lower": mean - z_thr * std,
            "upper": mean + z_thr * std,
            "z_threshold": z_thr,
            "sample_count": meta.get("sample_count"),
            "window_size": meta.get("window_size"),
        }
        if mean is not None and std is not None
        else None
    )

    return {
        "anomaly_id": anomaly.id,
        "window_minutes": int(window.total_seconds() // 60),
        "detected_at": iso(anomaly.detected_at),
        "sensor": ctx["sensor"] if ctx else None,
        "location": {"room": ctx["room"], "asset": ctx["asset"], "floor": ctx["floor"]}
        if ctx
        else None,
        "nodes": list(nodes.values()),
        "edges": edges,
        "evidence": {
            "readings": [
                {"t": iso(r.event_timestamp), "v": r.value, "source": _val(r.source)}
                for r in readings
            ],
            "baseline": baseline,
            "observed_value": anomaly.observed_value,
            "deviation_score": anomaly.deviation_score,
            "detector_config": meta.get("detector_config"),
        },
        "disclaimer": DISCLAIMER,
    }
