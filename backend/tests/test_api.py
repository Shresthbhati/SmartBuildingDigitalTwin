import pytest
from app.api import routes as route_module
from app.models.sensor import RoomStatus, SensorReading
from datetime import UTC, datetime
from fastapi import HTTPException


def test_health_endpoint(db_session):
    data = route_module.health_check(db=db_session)
    assert data.status in ("healthy", "degraded")
    assert data.version == "1.0.0"
    assert data.database in ("connected", "error")
    assert data.mqtt in ("connected", "disconnected")


def test_detailed_health_endpoint(db_session):
    data = route_module.detailed_health_check(db=db_session)
    assert data["status"] in ("healthy", "degraded")
    assert data["database"] == "connected"
    assert data["mqtt"] in ("connected", "disconnected")
    assert data["simulator"] in ("running", "stopped")


def test_latest_endpoint_returns_all_rooms(db_session):
    db_session.add(RoomStatus(room="room101", status="NORMAL", current_temperature=22.5))
    db_session.add(RoomStatus(room="room204", status="NORMAL", current_temperature=23.0))
    db_session.commit()

    data = route_module.get_latest_data(db=db_session)
    assert isinstance(data, list)
    rooms = {item.room for item in data}
    assert rooms == {
        "room101",
        "room102",
        "room103",
        "room104",
        "room201",
        "room202",
        "room203",
        "room204",
    }
    for item in data:
        assert item.status in ("NORMAL", "HIGH", "ALERT")
        assert isinstance(item.temperature, float)


def test_status_endpoint(db_session):
    data = route_module.get_room_status(db=db_session)
    assert isinstance(data, list)
    assert len(data) == 8
    for item in data:
        assert item.status in ("NORMAL", "HIGH", "ALERT")


def test_layout_endpoint(db_session):
    data = route_module.get_building_layout()
    floors = data.floors
    dimensions = data.dimensions
    floor_ids = [f.level for f in floors]
    assert 0 in floor_ids
    assert 1 in floor_ids
    all_rooms = [r.id for f in floors for r in f.rooms]
    assert "room101" in all_rooms
    assert "room204" in all_rooms
    assert dimensions["width"] == 20.0


def test_history_endpoint_empty(db_session):
    data = route_module.get_room_history(
        room="room101",
        sensor_id=None,
        measurement="temperature",
        start=None,
        end=None,
        limit=100,
        db=db_session,
    )
    assert data.room == "room101"
    assert data.readings == []


def test_history_endpoint_unknown_room(db_session):
    with pytest.raises(HTTPException) as exc:
        route_module.get_room_history(
            room="room999",
            sensor_id=None,
            measurement="temperature",
            start=None,
            end=None,
            limit=100,
            db=db_session,
        )
    assert exc.value.status_code == 404


def test_all_history_endpoint(db_session):
    data = route_module.get_all_history(
        sensor_id=None,
        measurement="temperature",
        start=None,
        end=None,
        limit=100,
        source=None,
        db=db_session,
    )
    assert isinstance(data, list)
    assert len(data) == 8


def test_activity_endpoint(db_session):
    data = route_module.get_activity_log(limit=50, db=db_session)
    assert isinstance(data, list)


def test_retention_status_endpoint(db_session):
    data = route_module.get_retention_status()
    assert "enabled" in data
    assert "last_run" in data


def test_simulator_status_endpoint(db_session):
    data = route_module.get_simulator_status()
    assert "running" in data
    assert "sensors" in data


def test_aggregate_endpoint_with_valid_params(db_session):
    from datetime import timedelta

    end = datetime.now(UTC)
    start = end - timedelta(hours=1)
    data = route_module.get_telemetry_aggregate(
        room="room101",
        sensor_id="temp-sensor-101",
        measurement="temperature",
        start=start,
        end=end,
        interval="15m",
        source=None,
        db=db_session,
    )
    assert data.room == "room101"
    assert data.sensor_id == "temp-sensor-101"
    assert isinstance(data.buckets, list)


def test_reading_persistence_and_retrieval(db_session):
    reading = SensorReading(
        room="room101",
        sensor_id="temp-sensor-101",
        measurement="temperature",
        value=31.0,
        unit="celsius",
        source="simulated",
        event_timestamp=datetime.now(UTC),
        idempotency_key="test-persist-1",
    )
    db_session.add(reading)
    db_session.commit()

    data = route_module.get_room_history(
        room="room101",
        sensor_id=None,
        measurement="temperature",
        start=None,
        end=None,
        limit=100,
        db=db_session,
    )
    assert len(data.readings) == 1
    assert data.readings[0].value == 31.0
    assert data.readings[0].room == "room101"


def test_latest_reflects_room_status(db_session):
    db_session.add(RoomStatus(room="room101", status="ALERT", current_temperature=37.0))
    db_session.commit()

    data = route_module.get_latest_data(db=db_session)
    room101 = next(r for r in data if r.room == "room101")
    assert room101.status == "ALERT"
    assert room101.temperature == 37.0


def test_counts_routes_not_shadowed_by_id_routes():
    from starlette.routing import Match

    def first_match(path):
        scope = {"type": "http", "path": path, "method": "GET"}
        return next(r.path for r in route_module.router.routes if r.matches(scope)[0] == Match.FULL)

    assert first_match("/api/alerts/counts") == "/api/alerts/counts"
    assert first_match("/api/anomalies/counts") == "/api/anomalies/counts"
    assert first_match("/api/alerts/5") == "/api/alerts/{alert_id}"


def test_aggregate_buckets_counts_and_avg(db_session):
    from datetime import timedelta

    start = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    for i, (mins, val) in enumerate([(1, 20.0), (5, 22.0), (16, 30.0)]):
        db_session.add(
            SensorReading(
                room="room101",
                sensor_id="temp-sensor-101",
                measurement="temperature",
                value=val,
                unit="celsius",
                source="simulated",
                event_timestamp=start + timedelta(minutes=mins),
                idempotency_key=f"agg-{i}",
            )
        )
    db_session.commit()
    data = route_module.get_telemetry_aggregate(
        room="room101",
        sensor_id="temp-sensor-101",
        measurement="temperature",
        start=start,
        end=start + timedelta(hours=1),
        interval="15m",
        source=None,
        db=db_session,
    )
    assert [b.count for b in data.buckets] == [2, 1]
    assert data.buckets[0].avg_value == 21.0
    assert data.buckets[0].min_value == 20.0 and data.buckets[0].max_value == 22.0
    assert data.buckets[1].bucket_start == start + timedelta(minutes=15)
    assert data.total_count == 3


def test_aggregate_bad_interval_is_400(db_session):
    from datetime import timedelta

    end = datetime.now(UTC)
    with pytest.raises(HTTPException) as exc:
        route_module.get_telemetry_aggregate(
            room="room101",
            sensor_id="temp-sensor-101",
            measurement="temperature",
            start=end - timedelta(hours=1),
            end=end,
            interval="bogus",
            source=None,
            db=db_session,
        )
    assert exc.value.status_code == 400
