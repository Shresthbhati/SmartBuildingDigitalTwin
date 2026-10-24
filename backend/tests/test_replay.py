import pytest
from app.models.alert import AlertStatus
from app.models.sensor import ReadingSource
from app.services.alert_service import alert_service
from app.services.replay_service import build_replay
from datetime import timedelta
from helpers import add_alert, add_reading, minutes_ago, now


def _sensor(body, sensor_id):
    return next(s for s in body["sensors"] if s["sensor_id"] == sensor_id)


def test_small_window_returns_raw_points_and_preserves_gaps(db_session):
    # One reading a minute for 30 minutes, except a 10-minute outage in the middle.
    for m in list(range(40, 30, -1)) + list(range(19, 9, -1)):
        add_reading(db_session, value=22.0 + m * 0.01, ts=minutes_ago(m))
    db_session.commit()

    body = build_replay(db_session, minutes_ago(45), now(), max_points=200)
    s = _sensor(body, "temp-sensor-101")
    assert s["resolution"] == "raw" and s["sample_count"] == len(s["points"]) == 20
    assert all(p["n"] == 1 for p in s["points"])

    from datetime import datetime

    times = [datetime.fromisoformat(p["t"]) for p in s["points"]]
    gaps = [(b - a).total_seconds() for a, b in zip(times, times[1:], strict=False)]
    assert max(gaps) >= 11 * 60  # the outage is a visible hole, not interpolated
    assert min(gaps) == pytest.approx(60, abs=1)


def test_large_window_is_aggregated_with_sample_counts(db_session):
    for i in range(240):  # 240 readings over 40 minutes
        add_reading(
            db_session, value=20.0 + (i % 10), ts=minutes_ago(40) + timedelta(seconds=10 * i)
        )
    db_session.commit()

    body = build_replay(db_session, minutes_ago(41), now(), max_points=12)
    s = _sensor(body, "temp-sensor-101")
    assert s["resolution"] == "aggregated" and s["sample_count"] == 240
    assert len(s["points"]) <= 13
    assert sum(p["n"] for p in s["points"]) == 240  # nothing dropped, only summarised
    assert all(p["lo"] <= p["v"] <= p["hi"] for p in s["points"])


def test_scenario_injected_readings_are_marked_in_raw_points(db_session):
    add_reading(db_session, ts=minutes_ago(3))
    add_reading(db_session, value=40.0, ts=minutes_ago(2), source=ReadingSource.SCENARIO)
    db_session.commit()
    points = _sensor(build_replay(db_session, minutes_ago(10), now()), "temp-sensor-101")["points"]
    assert [p.get("s") for p in points] == [None, "scenario"]


def test_floor_filter_limits_sensors_and_events(db_session):
    add_reading(db_session, ts=minutes_ago(2))
    add_reading(db_session, "temp-sensor-201", "room201", ts=minutes_ago(2))
    add_alert(db_session, room="room101", started=minutes_ago(5))
    add_alert(db_session, room="room201", sensor_id="temp-sensor-201", started=minutes_ago(5))
    db_session.commit()

    body = build_replay(db_session, minutes_ago(30), now(), floor=1)
    assert {s["floor"] for s in body["sensors"]} == {1}
    assert {a["room"] for a in body["alerts"]} == {"room201"}


def test_window_is_clamped_to_retention_and_says_so(db_session):
    body = build_replay(db_session, now() - timedelta(days=90), now())
    assert body["clamped_to_retention"] is True
    assert body["retention_days"] == 30
    assert body["start"] == body["retention_floor"] != body["requested_start"]


def test_window_fully_outside_retention_is_rejected(db_session):
    with pytest.raises(ValueError, match="retention"):
        build_replay(db_session, now() - timedelta(days=90), now() - timedelta(days=60))
    with pytest.raises(ValueError, match="after start"):
        build_replay(db_session, now(), now() - timedelta(hours=1))


def test_audit_rows_give_exact_lifecycle_history(db_session):
    alert_service.evaluate_reading(
        room="room101",
        sensor_id="temp-sensor-101",
        value=33.0,
        event_timestamp=minutes_ago(20),
        db=db_session,
    )
    alert_id = alert_service.get_alerts({}, db=db_session)[0].id
    alert_service.acknowledge_alert(alert_id, actor="ops", db=db_session)
    alert_service.resolve_alert(alert_id, actor="ops", db=db_session)

    body = build_replay(db_session, minutes_ago(60), now() + timedelta(minutes=1))
    events = [e for e in body["events"] if e["entity_type"] == "alert"]
    assert [(e["from"], e["to"], e["actor"], e["source"]) for e in events] == [
        (None, "OPEN", "system", "audit"),
        ("OPEN", "ACKNOWLEDGED", "ops", "audit"),
        ("ACKNOWLEDGED", "RESOLVED", "ops", "audit"),
    ]
    assert events[0]["at"] <= events[1]["at"] <= events[2]["at"]
    assert body["alerts"][0]["status"] == AlertStatus.RESOLVED.value


def test_entities_without_audit_rows_get_clearly_marked_derived_events(db_session):
    add_alert(
        db_session,
        started=minutes_ago(30),
        acknowledged=minutes_ago(20),
        resolved=minutes_ago(10),
        status=AlertStatus.RESOLVED,
    )
    db_session.commit()
    body = build_replay(db_session, minutes_ago(60), now())
    assert [(e["to"], e["source"]) for e in body["events"]] == [
        ("OPEN", "derived"),
        ("ACKNOWLEDGED", "derived"),
        ("RESOLVED", "derived"),
    ]


def test_events_outside_the_window_are_excluded(db_session):
    add_alert(
        db_session, started=minutes_ago(120), resolved=minutes_ago(5), status=AlertStatus.RESOLVED
    )
    db_session.commit()
    body = build_replay(db_session, minutes_ago(60), now())
    assert [e["to"] for e in body["events"]] == ["RESOLVED"]  # the open happened before the window
    assert len(body["alerts"]) == 1  # but the alert overlaps the window, so it is listed


def test_event_paging_sets_truncated(db_session):
    for i in range(3):
        add_alert(db_session, started=minutes_ago(30 - i), room="room101")
    db_session.commit()

    first = build_replay(db_session, minutes_ago(60), now(), event_limit=2)
    assert first["truncated"] is True
    assert len(first["events"]) == 2 and first["event_total"] == 3

    rest = build_replay(db_session, minutes_ago(60), now(), event_limit=2, event_offset=2)
    assert len(rest["events"]) == 1 and rest["truncated"] is False
    assert {e["entity_id"] for e in first["events"] + rest["events"]} == {
        e["entity_id"] for e in build_replay(db_session, minutes_ago(60), now())["events"]
    }


def test_empty_window_is_valid_not_an_error(db_session):
    body = build_replay(db_session, minutes_ago(10), now())
    assert all(s["points"] == [] and s["sample_count"] == 0 for s in body["sensors"])
    assert body["events"] == [] and body["truncated"] is False
