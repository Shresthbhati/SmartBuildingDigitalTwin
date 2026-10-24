import pytest
from app.core.events import bus
from app.models.alert import Alert, AlertStatus
from app.models.anomaly import AnomalyStatus
from app.models.lifecycle import EventLifecycleEvent
from app.services.alert_service import alert_service
from app.services.anomaly_service import anomaly_service
from app.services.lifecycle import track_transition
from helpers import add_anomaly, minutes_ago


@pytest.fixture
def published(monkeypatch):
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(bus, "publish", lambda type_, data, ts=None: events.append((type_, data)))
    return events


def _rows(db, entity_type, entity_id):
    return (
        db.query(EventLifecycleEvent)
        .filter_by(entity_type=entity_type, entity_id=entity_id)
        .order_by(EventLifecycleEvent.id)
        .all()
    )


def _make_alert(db):
    alert_service.evaluate_reading(
        room="room101",
        sensor_id="temp-sensor-101",
        value=33.0,
        event_timestamp=minutes_ago(10),
        db=db,
    )
    return db.query(Alert).one()


def test_alert_creation_writes_audit_row_and_event(db_session, published):
    alert = _make_alert(db_session)
    rows = _rows(db_session, "alert", alert.id)
    assert [(r.from_status, r.to_status, r.actor) for r in rows] == [(None, "OPEN", "system")]
    created = [d for t, d in published if t == "alert"]
    assert created and created[0]["event"] == "created" and created[0]["id"] == alert.id
    assert created[0]["alert_type"] == "high_temperature"


def test_acknowledge_and_resolve_are_audited_with_actor(db_session, published):
    alert = _make_alert(db_session)
    alert_service.acknowledge_alert(alert.id, actor="ops", db=db_session)
    alert_service.resolve_alert(alert.id, actor="ops", db=db_session)
    rows = _rows(db_session, "alert", alert.id)
    assert [(r.from_status, r.to_status, r.actor) for r in rows] == [
        (None, "OPEN", "system"),
        ("OPEN", "ACKNOWLEDGED", "ops"),
        ("ACKNOWLEDGED", "RESOLVED", "ops"),
    ]
    assert [d["event"] for t, d in published if t == "alert"] == [
        "created",
        "acknowledged",
        "resolved",
    ]


def test_repeat_acknowledge_is_a_noop_without_new_audit_row(db_session):
    alert = _make_alert(db_session)
    alert_service.acknowledge_alert(alert.id, actor="ops", db=db_session)
    alert_service.acknowledge_alert(alert.id, actor="someone-else", db=db_session)
    assert len(_rows(db_session, "alert", alert.id)) == 2
    db_session.refresh(alert)
    assert alert.acknowledged_by == "ops"  # the first acknowledgement stands


def test_failed_transition_leaves_no_audit_row(db_session):
    alert = _make_alert(db_session)
    alert_service.resolve_alert(alert.id, actor="ops", db=db_session)
    with pytest.raises(ValueError):
        alert_service.acknowledge_alert(alert.id, db=db_session)
    assert len(_rows(db_session, "alert", alert.id)) == 2


def test_automatic_recovery_is_audited_as_system(db_session):
    alert = _make_alert(db_session)
    alert_service.evaluate_reading(
        room="room101", sensor_id="temp-sensor-101", value=20.0, db=db_session
    )
    db_session.refresh(alert)
    assert alert.status == AlertStatus.RESOLVED
    last = _rows(db_session, "alert", alert.id)[-1]
    assert (last.from_status, last.to_status, last.actor) == ("OPEN", "RESOLVED", "system")


def test_anomaly_transitions_are_audited(db_session, published):
    anomaly = add_anomaly(db_session)
    db_session.commit()
    anomaly_service.acknowledge_anomaly(anomaly.id, actor="ops", db=db_session)
    anomaly_service.resolve_anomaly(anomaly.id, actor="ops", db=db_session)
    rows = _rows(db_session, "anomaly", anomaly.id)
    assert [(r.from_status, r.to_status, r.actor) for r in rows] == [
        ("OPEN", "ACKNOWLEDGED", "ops"),
        ("ACKNOWLEDGED", "RESOLVED", "ops"),
    ]
    db_session.refresh(anomaly)
    assert anomaly.status == AnomalyStatus.RESOLVED
    assert [d["event"] for t, d in published if t == "anomaly"] == ["acknowledged", "resolved"]


def test_events_publish_only_after_commit_and_never_after_rollback(db_session, published):
    anomaly = add_anomaly(db_session)
    db_session.commit()
    published.clear()

    track_transition(db_session, "anomaly", anomaly, "OPEN", "ACKNOWLEDGED", "ops")
    assert published == []  # queued, not yet visible to clients
    db_session.rollback()
    db_session.commit()
    assert published == []  # rolled back: nothing may be announced

    track_transition(db_session, "anomaly", anomaly, "OPEN", "ACKNOWLEDGED", "ops")
    db_session.commit()
    assert len(published) == 1 and published[0][1]["status"] == "ACKNOWLEDGED"
