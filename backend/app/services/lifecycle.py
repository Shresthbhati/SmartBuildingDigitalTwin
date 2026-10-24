"""Audit trail + event emission for alert/anomaly status transitions.

`track_transition` adds an append-only `lifecycle_events` row and queues a WebSocket
event on the session. Queued events are published only after the transaction commits
(and dropped on rollback) so a client that reacts to an event and re-reads over REST
always sees the committed state.
"""

from app.core.events import bus
from app.core.timeutil import as_utc
from app.models.lifecycle import EventLifecycleEvent
from datetime import UTC, datetime
from sqlalchemy import event
from sqlalchemy.orm import Session


def _val(x):
    return getattr(x, "value", x)


def emit_after_commit(db: Session, type_: str, data: dict) -> None:
    db.info.setdefault("pending_events", []).append((type_, data))


@event.listens_for(Session, "after_commit")
def _publish_pending(session: Session) -> None:
    for type_, data in session.info.pop("pending_events", []):
        bus.publish(type_, data)


@event.listens_for(Session, "after_rollback")
def _drop_pending(session: Session) -> None:
    session.info.pop("pending_events", None)


def track_transition(
    db: Session,
    entity_type: str,
    entity,
    from_status,
    to_status,
    actor: str | None = None,
    at: datetime | None = None,
    event_name: str | None = None,
) -> None:
    """Record one lifecycle transition for an alert/anomaly (entity must have an id)."""
    at = as_utc(at) if at is not None else datetime.now(UTC)
    db.add(
        EventLifecycleEvent(
            entity_type=entity_type,
            entity_id=entity.id,
            from_status=_val(from_status) if from_status is not None else None,
            to_status=_val(to_status),
            actor=actor,
            at=at,
        )
    )
    data = {
        "event": event_name or _val(to_status).lower(),
        "id": entity.id,
        "room": entity.room,
        "sensor_id": entity.sensor_id,
        "severity": _val(entity.severity),
        "status": _val(to_status),
        "title": entity.title,
        "actor": actor,
        "at": at.isoformat(),
    }
    if entity_type == "alert":
        data["alert_type"] = _val(entity.alert_type)
    else:
        data["anomaly_category"] = _val(entity.anomaly_category)
    emit_after_commit(db, entity_type, data)
