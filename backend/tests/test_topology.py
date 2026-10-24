from app.core.config import settings
from app.models.topology import Asset, Building, Floor, Room, Sensor
from app.services.topology_service import (
    get_topology_tree,
    location_codes,
    seed_topology,
    sim_sensors,
    touch_last_seen,
)
from datetime import timedelta
from helpers import now


def _counts(db):
    return tuple(db.query(m).count() for m in (Building, Floor, Room, Asset, Sensor))


def test_seed_creates_configured_topology(db_session):
    assert _counts(db_session) == (1, 2, 8, 4, 10)
    assert set(settings.topology.room_codes()) == {r.code for r in db_session.query(Room).all()}


def test_seed_is_idempotent(db_session):
    before = _counts(db_session)
    seed_topology(db_session)
    seed_topology(db_session)
    assert _counts(db_session) == before


def test_reseed_updates_config_but_keeps_runtime_state(db_session):
    sensor = db_session.query(Sensor).filter_by(sensor_id="temp-sensor-101").one()
    seen = now()
    sensor.last_seen_at = seen
    sensor.baseline = 99.0  # drifted away from config
    db_session.commit()

    seed_topology(db_session)
    db_session.refresh(sensor)
    assert sensor.baseline == 22.0  # config wins for structure/simulation params
    assert sensor.last_seen_at is not None  # runtime state survives


def test_sensor_location_and_floor(db_session):
    room_sensor = db_session.query(Sensor).filter_by(sensor_id="temp-sensor-204").one()
    meter = db_session.query(Sensor).filter_by(sensor_id="power-meter-f1").one()
    assert (room_sensor.location_code, room_sensor.floor_level) == ("room204", 1)
    assert (meter.location_code, meter.floor_level) == ("meter-f1", 1)
    assert meter.type == "power_kw" and meter.unit == "kW"


def test_location_codes_include_assets(db_session):
    codes = location_codes(db_session)
    assert {"room101", "meter-f0", "ahu-f1"} <= codes
    assert "room999" not in codes


def test_sim_sensors_cover_every_enabled_simulated_sensor(db_session):
    sensors = sim_sensors(db_session)
    assert len(sensors) == 10
    assert {s.type for s in sensors} == {"temperature", "power_kw"}
    s101 = next(s for s in sensors if s.sensor_id == "temp-sensor-101")
    assert (s101.location, s101.baseline, s101.variation) == ("room101", 22.0, 1.5)

    disabled = db_session.query(Sensor).filter_by(sensor_id="temp-sensor-101").one()
    disabled.enabled = False
    db_session.commit()
    assert "temp-sensor-101" not in {s.sensor_id for s in sim_sensors(db_session)}


def test_touch_last_seen_only_moves_forward(db_session):
    t1 = now() - timedelta(minutes=5)
    t2 = now()
    touch_last_seen(db_session, "temp-sensor-101", t1)
    touch_last_seen(db_session, "temp-sensor-101", t2)
    touch_last_seen(db_session, "temp-sensor-101", t1)  # late arrival must not rewind
    touch_last_seen(db_session, "no-such-sensor", t2)  # unknown sensors are ignored
    db_session.commit()
    sensor = db_session.query(Sensor).filter_by(sensor_id="temp-sensor-101").one()
    assert abs((sensor.last_seen_at.replace(tzinfo=t2.tzinfo) - t2).total_seconds()) < 1


def test_tree_nests_rooms_assets_and_sensors(db_session):
    tree = get_topology_tree(db_session)
    meter = next(a for a in tree["floors"][0]["assets"] if a["kind"] == "meter")
    assert meter["sensors"][0]["sensor_id"] == "power-meter-f0"
    assert meter["room"] is None
    assert tree["floors"][1]["elevation_m"] == 4.0
