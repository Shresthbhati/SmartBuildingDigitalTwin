"""Alert integration tests covering the full telemetry-to-alert lifecycle.

Each test creates its own isolated SQLite database to avoid session state
issues with shared fixtures.
"""

import contextlib
import os
import pytest
import tempfile
from app.core.database import Base
from app.models.alert import Alert, AlertSeverity, AlertStatus, AlertType
from app.services.alert_service import alert_service
from datetime import UTC, datetime, timedelta
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def _make_engine():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = SessionLocal()
    return engine, session, path


def _close_engine(engine, session, path):
    session.close()
    engine.dispose()
    with contextlib.suppress(OSError):
        os.unlink(path)


def _make_timestamp(minutes_ago: int = 0) -> datetime:
    return datetime.now(UTC) - timedelta(minutes=minutes_ago)


def _count_alerts(
    db, room="room101", sensor_id="temp-sensor-101", alert_type=AlertType.HIGH_TEMPERATURE
) -> int:
    """Count only active (OPEN/ACKNOWLEDGED) alerts."""
    return (
        db.query(Alert)
        .filter(
            Alert.room == room,
            Alert.sensor_id == sensor_id,
            Alert.alert_type == alert_type,
            Alert.status.in_([AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED]),
        )
        .count()
    )


def _get_active_alert(
    db, room="room101", sensor_id="temp-sensor-101", alert_type=AlertType.HIGH_TEMPERATURE
) -> Alert | None:
    return alert_service._find_active_alert(db, room, sensor_id, alert_type)


# --------------------------------------------------------------------- #
# 1. Baseline: normal reading → no alert                                #
# --------------------------------------------------------------------- #
def test_normal_reading_no_alert():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=22.5,
            event_timestamp=_make_timestamp(),
            db=session,
        )
        assert _count_alerts(session) == 0
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 2. Warning threshold → exactly one warning alert                      #
# --------------------------------------------------------------------- #
def test_warning_reading_creates_one_alert():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=31.0,
            event_timestamp=_make_timestamp(),
            db=session,
        )
        assert _count_alerts(session) == 1
        alert = _get_active_alert(session)
        assert alert is not None
        assert alert.severity == AlertSeverity.WARNING
        assert alert.status == AlertStatus.OPEN
        assert alert.alert_type == AlertType.HIGH_TEMPERATURE
        assert alert.last_reading_value == 31.0
        assert alert.threshold_value == 30.0  # warning threshold
        assert alert.occurrence_count == 1
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 3. Idempotency: same warning reading → no duplicate, count updated    #
# --------------------------------------------------------------------- #
def test_repeated_warning_reading_no_duplicate():
    engine, session, path = _make_engine()
    try:
        ts1 = _make_timestamp(10)
        ts2 = _make_timestamp(5)

        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=31.0,
            event_timestamp=ts1,
            db=session,
        )
        assert _count_alerts(session) == 1
        alert1 = _get_active_alert(session)
        assert alert1.occurrence_count == 1
        first_occurrence = alert1.last_occurrence

        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=32.0,
            event_timestamp=ts2,
            db=session,
        )
        assert _count_alerts(session) == 1
        alert2 = _get_active_alert(session)
        assert alert2.id == alert1.id
        assert alert2.occurrence_count == 2
        assert alert2.last_reading_value == 32.0
        assert alert2.last_occurrence > first_occurrence
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 4. Escalation: warning → critical                                     #
# --------------------------------------------------------------------- #
def test_warning_to_critical_escalation():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=31.0,
            event_timestamp=_make_timestamp(20),
            db=session,
        )
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=36.0,
            event_timestamp=_make_timestamp(10),
            db=session,
        )
        assert (
            session.query(Alert)
            .filter(
                Alert.room == "room101",
                Alert.sensor_id == "temp-sensor-101",
                Alert.status.in_([AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED]),
            )
            .count()
            == 1
        )
        alert = _get_active_alert(
            session,
            room="room101",
            sensor_id="temp-sensor-101",
            alert_type=AlertType.CRITICAL_TEMPERATURE,
        )
        assert alert.alert_type == AlertType.CRITICAL_TEMPERATURE
        assert alert.severity == AlertSeverity.CRITICAL
        assert alert.last_reading_value == 36.0
        # Acknowledgment history preserved across escalation
        alert_service.acknowledge_alert(alert.id, actor="operator1", db=session)
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=37.0,
            event_timestamp=_make_timestamp(5),
            db=session,
        )
        alert = _get_active_alert(
            session,
            room="room101",
            sensor_id="temp-sensor-101",
            alert_type=AlertType.CRITICAL_TEMPERATURE,
        )
        assert alert.status == AlertStatus.ACKNOWLEDGED
        assert alert.acknowledged_by == "operator1"
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 5. Recovery → resolution                                              #
# --------------------------------------------------------------------- #
def test_recovery_reading_resolves_alert():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=36.0,
            event_timestamp=_make_timestamp(20),
            db=session,
        )
        assert (
            session.query(Alert)
            .filter(
                Alert.room == "room101",
                Alert.sensor_id == "temp-sensor-101",
                Alert.status.in_([AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED]),
            )
            .count()
            == 1
        )
        assert (
            _get_active_alert(
                session,
                room="room101",
                sensor_id="temp-sensor-101",
                alert_type=AlertType.CRITICAL_TEMPERATURE,
            )
            is not None
        )

        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=27.0,
            event_timestamp=_make_timestamp(5),
            db=session,
        )
        assert (
            _get_active_alert(
                session,
                room="room101",
                sensor_id="temp-sensor-101",
                alert_type=AlertType.CRITICAL_TEMPERATURE,
            )
            is None
        )
        total = (
            session.query(Alert)
            .filter(
                Alert.room == "room101",
                Alert.sensor_id == "temp-sensor-101",
                Alert.alert_type == AlertType.CRITICAL_TEMPERATURE,
            )
            .count()
        )
        assert total == 1
        resolved = (
            session.query(Alert)
            .filter(
                Alert.room == "room101",
                Alert.status == AlertStatus.RESOLVED,
            )
            .first()
        )
        assert resolved is not None
        assert resolved.resolved_at is not None
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 6. Hysteresis: fluctuation near threshold → no flapping               #
# --------------------------------------------------------------------- #
def test_hysteresis_prevents_flapping():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=30.1,
            event_timestamp=_make_timestamp(30),
            db=session,
        )
        assert _count_alerts(session) == 1

        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=29.9,
            event_timestamp=_make_timestamp(25),
            db=session,
        )
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=30.05,
            event_timestamp=_make_timestamp(20),
            db=session,
        )
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=29.8,
            event_timestamp=_make_timestamp(15),
            db=session,
        )
        assert _count_alerts(session) == 1
        alert = _get_active_alert(session)
        assert alert.status == AlertStatus.OPEN
        assert alert.severity == AlertSeverity.WARNING

        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=27.0,
            event_timestamp=_make_timestamp(5),
            db=session,
        )
        assert _get_active_alert(session) is None
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 7. Direct critical reading (skip warning)                             #
# --------------------------------------------------------------------- #
def test_direct_critical_alert():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room201",
            sensor_id="temp-sensor-201",
            value=37.0,
            event_timestamp=_make_timestamp(),
            db=session,
        )
        assert (
            session.query(Alert)
            .filter(
                Alert.room == "room201",
                Alert.sensor_id == "temp-sensor-201",
                Alert.status.in_([AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED]),
            )
            .count()
            == 1
        )
        alert = _get_active_alert(
            session,
            room="room201",
            sensor_id="temp-sensor-201",
            alert_type=AlertType.CRITICAL_TEMPERATURE,
        )
        assert alert.alert_type == AlertType.CRITICAL_TEMPERATURE
        assert alert.severity == AlertSeverity.CRITICAL
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 8. Stale sensor detection                                             #
# --------------------------------------------------------------------- #
def test_stale_sensor_detection():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room102",
            sensor_id="temp-sensor-102",
            value=22.0,
            event_timestamp=_make_timestamp(200),
            db=session,
        )
        alert_service.evaluate_stale_sensors(db=session)
        alerts = (
            session.query(Alert)
            .filter(
                Alert.room == "room102",
                Alert.alert_type == AlertType.STALE_SENSOR,
            )
            .all()
        )
        assert len(alerts) >= 1
        stale_alert = alerts[0]
        assert stale_alert.severity == AlertSeverity.WARNING
        assert stale_alert.status == AlertStatus.OPEN

        alert_service.evaluate_reading(
            room="room102",
            sensor_id="temp-sensor-102",
            value=22.0,
            event_timestamp=_make_timestamp(),
            db=session,
        )
        assert (
            alert_service._find_active_alert(
                session, "room102", "temp-sensor-102", AlertType.STALE_SENSOR
            )
            is None
        )
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 9. Invalid reading                                                    #
# --------------------------------------------------------------------- #
def test_invalid_reading_alert():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room103",
            sensor_id="temp-sensor-103",
            value=45.0,
            event_timestamp=_make_timestamp(),
            db=session,
        )
        alerts = (
            session.query(Alert)
            .filter(
                Alert.room == "room103",
                Alert.alert_type == AlertType.INVALID_READING,
            )
            .all()
        )
        assert len(alerts) == 1
        assert alerts[0].severity == AlertSeverity.WARNING
        assert alerts[0].last_reading_value == 45.0

        alert_service.evaluate_reading(
            room="room103",
            sensor_id="temp-sensor-103",
            value=46.0,
            event_timestamp=_make_timestamp(),
            db=session,
        )
        assert (
            session.query(Alert)
            .filter(
                Alert.room == "room103",
                Alert.alert_type == AlertType.INVALID_READING,
            )
            .count()
            == 1
        )
        alert = (
            session.query(Alert)
            .filter(
                Alert.room == "room103",
                Alert.alert_type == AlertType.INVALID_READING,
            )
            .first()
        )
        assert alert.occurrence_count == 2
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 10. Acknowledge and invalid lifecycle transitions                     #
# --------------------------------------------------------------------- #
def test_acknowledge_and_invalid_transitions():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room104",
            sensor_id="temp-sensor-104",
            value=33.0,
            event_timestamp=_make_timestamp(),
            db=session,
        )
        alert = _get_active_alert(session, room="room104", sensor_id="temp-sensor-104")
        assert alert is not None
        assert alert.status == AlertStatus.OPEN

        acked = alert_service.acknowledge_alert(alert.id, actor="ops", db=session)
        assert acked.status == AlertStatus.ACKNOWLEDGED
        assert acked.acknowledged_by == "ops"

        resolved = alert_service.resolve_alert(alert.id, db=session)
        assert resolved.status == AlertStatus.RESOLVED
        assert resolved.resolved_at is not None

        with pytest.raises(ValueError):
            alert_service.acknowledge_alert(alert.id, db=session)

        with pytest.raises(ValueError):
            alert_service.resolve_alert(alert.id, db=session)

        assert alert_service.acknowledge_alert(99999, db=session) is None
        assert alert_service.resolve_alert(99999, db=session) is None
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 11. Alert counts                                                      #
# --------------------------------------------------------------------- #
def test_alert_counts():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=33.0,
            event_timestamp=_make_timestamp(),
            db=session,
        )
        alert_service.evaluate_reading(
            room="room102",
            sensor_id="temp-sensor-102",
            value=37.0,
            event_timestamp=_make_timestamp(),
            db=session,
        )
        counts = alert_service.get_alert_counts(db=session)
        assert counts["total"] == 2
        severities = {s["severity"]: s["count"] for s in counts["by_severity"]}
        assert severities.get("WARNING") == 1
        assert severities.get("CRITICAL") == 1
        statuses = {s["status"]: s["count"] for s in counts["by_status"]}
        assert statuses.get("OPEN") == 2
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 12. List alerts with filters                                          #
# --------------------------------------------------------------------- #
def test_list_alerts_with_filters():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=33.0,
            event_timestamp=_make_timestamp(),
            db=session,
        )
        alert_service.evaluate_reading(
            room="room204",
            sensor_id="temp-sensor-204",
            value=37.0,
            event_timestamp=_make_timestamp(),
            db=session,
        )

        all_alerts = alert_service.get_alerts({}, db=session)
        assert len(all_alerts) == 2

        room_alerts = alert_service.get_alerts({"room": "room101"}, db=session)
        assert len(room_alerts) == 1
        assert room_alerts[0].room == "room101"

        critical_alerts = alert_service.get_alerts({"severity": AlertSeverity.CRITICAL}, db=session)
        assert len(critical_alerts) == 1
        assert critical_alerts[0].room == "room204"
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 13. Alert detail retrieval                                            #
# --------------------------------------------------------------------- #
def test_get_alert_by_id():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=33.0,
            event_timestamp=_make_timestamp(),
            db=session,
        )
        alert = _get_active_alert(session, room="room101")
        assert alert is not None

        fetched = alert_service.get_alert(alert.id, db=session)
        assert fetched is not None
        assert fetched.id == alert.id
        assert fetched.room == "room101"

        assert alert_service.get_alert(99999, db=session) is None
    finally:
        _close_engine(engine, session, path)


# --------------------------------------------------------------------- #
# 14. Recurrence after resolution creates new incident                  #
# --------------------------------------------------------------------- #
def test_recurrence_after_resolution_creates_new_incident():
    engine, session, path = _make_engine()
    try:
        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=36.0,
            event_timestamp=_make_timestamp(30),
            db=session,
        )
        alert = _get_active_alert(
            session,
            room="room101",
            sensor_id="temp-sensor-101",
            alert_type=AlertType.CRITICAL_TEMPERATURE,
        )
        assert alert is not None
        alert_service.resolve_alert(alert.id, db=session)

        alert_service.evaluate_reading(
            room="room101",
            sensor_id="temp-sensor-101",
            value=37.0,
            event_timestamp=_make_timestamp(5),
            db=session,
        )
        all_alerts = (
            session.query(Alert)
            .filter(
                Alert.room == "room101",
                Alert.sensor_id == "temp-sensor-101",
                Alert.alert_type == AlertType.CRITICAL_TEMPERATURE,
            )
            .all()
        )
        assert len(all_alerts) == 2
        new_alert = _get_active_alert(
            session,
            room="room101",
            sensor_id="temp-sensor-101",
            alert_type=AlertType.CRITICAL_TEMPERATURE,
        )
        assert new_alert is not None
        assert new_alert.status == AlertStatus.OPEN
        assert new_alert.id != alert.id
    finally:
        _close_engine(engine, session, path)
