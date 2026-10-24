import pytest
from app.models.alert import AlertType
from app.models.topology import Sensor
from app.services.maintenance_service import compute_flags, energy_summary, forecast
from datetime import timedelta
from helpers import add_alert, add_anomaly, add_reading, minutes_ago, now


def _rules(db, sensor_id="temp-sensor-101"):
    return {f["rule"]: f for f in compute_flags(db)["flags"] if f["sensor_id"] == sensor_id}


def test_no_flags_without_evidence(db_session):
    body = compute_flags(db_session)
    assert body["flags"] == [] and body["basis"] == "rule-based (v1)"
    assert "not a prediction" in body["disclaimer"].lower()


def test_anomaly_frequency_flag_links_to_evidence(db_session):
    anomalies = [add_anomaly(db_session, detected=minutes_ago(60 * (i + 1))) for i in range(3)]
    add_anomaly(db_session, sensor_id="temp-sensor-102", room="room102")  # other sensor: ignored
    db_session.commit()
    flag = _rules(db_session)["anomaly_frequency"]
    assert flag["evidence"]["count"] == 3
    assert {link["id"] for link in flag["evidence_links"]} == {a.id for a in anomalies}
    assert all(link["kind"] == "anomaly" for link in flag["evidence_links"])
    assert "anomaly_frequency" not in _rules(db_session, "temp-sensor-102")


def test_below_threshold_does_not_flag(db_session):
    for i in range(2):
        add_anomaly(db_session, detected=minutes_ago(30 * (i + 1)))
    db_session.commit()
    assert "anomaly_frequency" not in _rules(db_session)


def test_old_evidence_outside_lookback_is_ignored(db_session):
    for i in range(5):
        add_anomaly(db_session, detected=now() - timedelta(days=10 + i))
    db_session.commit()
    assert _rules(db_session) == {}


def test_alert_recurrence_and_flapping(db_session):
    for i in range(3):
        add_alert(db_session, started=minutes_ago(100 * (i + 1)))
    for i in range(4):
        add_alert(db_session, alert_type=AlertType.STALE_SENSOR, started=minutes_ago(50 * (i + 1)))
    db_session.commit()
    rules = _rules(db_session)
    assert rules["alert_recurrence"]["evidence"]["alert_type"] == "high_temperature"
    assert rules["sensor_flapping"]["evidence"]["count"] == 4
    assert len(rules["sensor_flapping"]["evidence_links"]) == 4


def test_time_in_warning_flag(db_session):
    for i in range(10):
        add_reading(db_session, value=31.0 if i < 4 else 22.0, ts=minutes_ago(i + 1))
    db_session.commit()
    flag = _rules(db_session)["time_in_warning"]
    assert flag["evidence"]["ratio"] == 0.4 and flag["severity"] == "watch"


def test_stale_sensor_flag(db_session):
    sensor = db_session.query(Sensor).filter_by(sensor_id="temp-sensor-101").one()
    sensor.last_seen_at = minutes_ago(30)
    db_session.commit()
    assert "stale_now" in _rules(db_session)


# --- forecast -------------------------------------------------------------------------
def _trend(db, n=20, per_min=0.1, start=22.0, sensor="temp-sensor-101", room="room101"):
    for i in range(n):
        m = n - i
        add_reading(db, sensor, room, round(start + per_min * i, 3), minutes_ago(m * 0.5))
    db.commit()


def test_forecast_extrapolates_a_clean_trend_and_is_labelled_estimated(db_session):
    _trend(db_session, per_min=0.1)  # +0.1 per reading, one reading per 30 s -> 12 per hour
    body = forecast(db_session, "temp-sensor-101", horizon_minutes=30)
    assert body["abstained"] is False and body["label"] == "estimated"
    assert body["slope_per_hour"] == pytest.approx(12.0, rel=0.05)
    values = [p["v"] for p in body["points"]]
    assert values == sorted(values) and len(values) >= 5
    assert all(p["lo"] <= p["v"] <= p["hi"] for p in body["points"])
    assert body["based_on"]["n"] == 20


def test_forecast_band_widens_with_noisier_data(db_session):
    import random

    rng = random.Random(3)
    for i in range(20):
        add_reading(
            db_session,
            "temp-sensor-101",
            "room101",
            22.0 + rng.uniform(-2, 2),
            minutes_ago((20 - i) * 0.5),
        )
    add_reading(db_session, "temp-sensor-102", "room102", 22.0, minutes_ago(0.2))
    db_session.commit()
    noisy = forecast(db_session, "temp-sensor-101")
    assert noisy["residual_std"] > 0.5
    first, last = noisy["points"][0], noisy["points"][-1]
    assert (last["hi"] - last["lo"]) >= (first["hi"] - first["lo"])


def test_forecast_abstains_when_sparse(db_session):
    for m in (3, 2, 1):
        add_reading(db_session, ts=minutes_ago(m))
    db_session.commit()
    body = forecast(db_session, "temp-sensor-101")
    assert (body["abstained"], body["reason"], body["points"]) == (True, "sparse", [])


def test_forecast_abstains_when_data_is_stale(db_session):
    for i in range(20):
        add_reading(db_session, ts=minutes_ago(25 - i * 0.2))  # last reading ~21 min ago
    db_session.commit()
    body = forecast(db_session, "temp-sensor-101")
    assert (body["abstained"], body["reason"]) == (True, "stale")


def test_forecast_unknown_sensor(db_session):
    with pytest.raises(LookupError):
        forecast(db_session, "nope")


# --- energy ---------------------------------------------------------------------------
def test_energy_kwh_coverage_and_peak(db_session):
    end = now()
    start = end - timedelta(hours=1)
    for k in range(12):  # constant 10 kW, one reading per 5-minute bucket
        add_reading(
            db_session,
            "power-meter-f0",
            "meter-f0",
            10.0,
            start + timedelta(minutes=5 * k, seconds=30),
            measurement="power_kw",
            unit="kW",
        )
    add_reading(
        db_session,
        "power-meter-f0",
        "meter-f0",
        18.0,
        start + timedelta(minutes=31),
        measurement="power_kw",
        unit="kW",
    )
    db_session.commit()

    body = energy_summary(db_session, start, end)
    m = next(x for x in body["meters"] if x["sensor_id"] == "power-meter-f0")
    assert m["label"] == "simulated" and m["source"] == "simulated"
    assert m["coverage"] == 1.0
    assert m["peak_kw"] == 18.0
    assert m["kwh"] == pytest.approx(
        10.0 + (14.0 - 10.0) * (5 / 60) / 1, abs=0.2
    )  # one bucket averages 14
    assert "kWh" in body["note"]


def test_energy_gaps_reduce_coverage_and_are_not_interpolated(db_session):
    end = now()
    start = end - timedelta(hours=1)
    for k in (0, 1, 2, 3):  # only the first 20 minutes have data
        add_reading(
            db_session,
            "power-meter-f1",
            "meter-f1",
            12.0,
            start + timedelta(minutes=5 * k, seconds=10),
            measurement="power_kw",
            unit="kW",
        )
    db_session.commit()
    m = next(
        x
        for x in energy_summary(db_session, start, end)["meters"]
        if x["sensor_id"] == "power-meter-f1"
    )
    assert m["coverage"] == pytest.approx(4 / 12, abs=0.01)
    assert m["kwh"] == pytest.approx(12.0 * 4 * 5 / 60, abs=0.01)  # 4 observed buckets only


def test_energy_rejects_inverted_window(db_session):
    with pytest.raises(ValueError):
        energy_summary(db_session, now(), now() - timedelta(hours=1))
