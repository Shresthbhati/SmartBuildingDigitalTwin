"""Simulator + ingestion integration, using the in-process ("direct") transport: no broker."""

import pytest
from app.models.sensor import ReadingSource, RoomStatus, SensorReading
from app.models.topology import Sensor
from app.services.simulator_service import SensorSimulator
from datetime import timedelta


@pytest.fixture
def sim(db_session):
    s = SensorSimulator()
    s.transport = "direct"
    s.load_sensors()
    s.running = True  # drive ticks by hand; no background thread
    return s


def _readings(db, **filters):
    db.rollback()  # see rows committed by the ingestion path's own sessions
    return db.query(SensorReading).filter_by(**filters).order_by(SensorReading.id).all()


def test_tick_publishes_every_simulated_sensor_through_the_real_ingest_path(db_session, sim):
    sim._publish_readings()
    rows = _readings(db_session)
    assert len(rows) == len(sim.sensors) == 10
    assert {r.measurement for r in rows} == {"temperature", "power_kw"}
    assert {r.source for r in rows} == {ReadingSource.SIMULATED}
    meter = next(r for r in rows if r.sensor_id == "power-meter-f0")
    assert (meter.room, meter.unit) == ("meter-f0", "kW")


def test_ingest_updates_last_seen_and_room_status_for_temperature_only(db_session, sim):
    sim._publish_readings()
    db_session.rollback()
    assert db_session.query(Sensor).filter(Sensor.last_seen_at.is_(None)).count() == 0
    statuses = {s.room for s in db_session.query(RoomStatus).all()}
    assert statuses == {f"room{n}" for n in (101, 102, 103, 104, 201, 202, 203, 204)}
    assert "meter-f0" not in statuses  # meters have no room status


def test_ticks_are_deterministic_for_a_given_seed(db_session):
    def run():
        s = SensorSimulator()
        s.transport = "direct"
        s.load_sensors()
        return [
            s._next_value(x, __import__("datetime").datetime(2026, 3, 2, 12, 0))
            for x in s.sensors[:3]
        ]

    assert run() == run()


def test_spike_injection_is_tagged_scenario_and_offsets_the_value(db_session, sim):
    sim._publish_readings()  # normal tick first
    info = sim.inject("temp-sensor-102", "spike", duration_seconds=60, magnitude=12.0)
    assert info["kind"] == "spike" and sim.active_injections()[0]["sensor_id"] == "temp-sensor-102"
    sim._publish_readings()

    rows = _readings(db_session, sensor_id="temp-sensor-102")
    normal, injected = rows[0], rows[1]
    assert normal.source == ReadingSource.SIMULATED and injected.source == ReadingSource.SCENARIO
    assert injected.value - normal.value > 8  # walk moves ~1 degree; the spike adds 12
    others = _readings(db_session, sensor_id="temp-sensor-101")
    assert {r.source for r in others} == {ReadingSource.SIMULATED}  # only the target is affected


def test_injection_does_not_corrupt_the_underlying_walk(db_session, sim):
    sim.inject("temp-sensor-101", "spike", duration_seconds=60, magnitude=12.0)
    sim._publish_readings()
    assert abs(sim._walk["temp-sensor-101"] - 22.0) < 6  # the signal itself stayed near baseline
    assert sim.temperatures["temp-sensor-101"] > 30  # but the reported value was the spiked one


def test_drift_ramps_up(db_session, sim):
    sim.inject("temp-sensor-103", "drift", duration_seconds=60, magnitude=10.0)
    offsets = []
    for _ in range(5):
        sim._publish_readings()
        offsets.append(round(sim.temperatures["temp-sensor-103"] - sim._walk["temp-sensor-103"], 2))
    assert offsets == [1.0, 2.0, 3.0, 4.0, 5.0]  # gradual: 10% of the magnitude per tick
    rows = _readings(db_session, sensor_id="temp-sensor-103")
    assert {r.source for r in rows} == {ReadingSource.SCENARIO}


def test_offline_injection_goes_silent(db_session, sim):
    sim.inject("temp-sensor-104", "offline", duration_seconds=60)
    sim._publish_readings()
    sim._publish_readings()
    assert _readings(db_session, sensor_id="temp-sensor-104") == []
    assert len(_readings(db_session, sensor_id="temp-sensor-101")) == 2


def test_injection_expires(db_session, sim):
    sim.inject("temp-sensor-101", "spike", duration_seconds=1)
    sim.injections["temp-sensor-101"].until = sim.injections["temp-sensor-101"].started - timedelta(
        seconds=1
    )
    sim._publish_readings()
    assert _readings(db_session, sensor_id="temp-sensor-101")[0].source == ReadingSource.SIMULATED
    assert sim.active_injections() == []


@pytest.mark.parametrize(
    "args, error",
    [
        (("temp-sensor-101", "explode", 10), ValueError),
        (("temp-sensor-101", "spike", 0), ValueError),
        (("temp-sensor-101", "spike", 99999), ValueError),
        (("nope", "spike", 10), LookupError),
    ],
)
def test_inject_validates_input(sim, args, error):
    with pytest.raises(error):
        sim.inject(*args)


def test_inject_requires_a_running_simulator(db_session):
    s = SensorSimulator()
    s.load_sensors()
    with pytest.raises(RuntimeError):
        s.inject("temp-sensor-101", "spike", 10)


def test_duplicate_idempotency_keys_are_ignored(db_session, sim):
    from app.services.mqtt_service import mqtt_service

    payload = {
        "sensor_id": "temp-sensor-101",
        "room": "room101",
        "measurement": "temperature",
        "value": 22.5,
        "unit": "celsius",
        "source": "simulated",
        "event_timestamp": "2026-03-02T12:00:00+00:00",
        "idempotency_key": "dup-1",
    }
    mqtt_service.ingest("room101", payload)
    mqtt_service.ingest("room101", payload)
    assert len(_readings(db_session, idempotency_key="dup-1")) == 1
