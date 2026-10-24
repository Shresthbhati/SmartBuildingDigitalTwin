import pytest
from app.models.scenario import ScenarioRun
from app.models.sensor import SensorReading
from app.services import sim_model
from app.services.scenario_service import get_run, list_runs, run_scenario
from datetime import UTC, datetime
from helpers import add_reading

START = datetime(2026, 3, 2, 6, 0, tzinfo=UTC)


def _run(db, **kw):
    kw.setdefault("sensor_id", "temp-sensor-101")
    kw.setdefault("window_minutes", 60)
    kw.setdefault("start", START)
    return run_scenario(db, **kw)


def _vals(series):
    return [p["v"] for p in series]


def test_live_telemetry_is_never_touched(db_session):
    add_reading(db_session)
    db_session.commit()
    before = db_session.query(SensorReading).count()

    _run(db_session, baseline_offset=5, variation_scale=3)
    _run(db_session, baseline_offset=-5, save=True)

    assert db_session.query(SensorReading).count() == before


def test_unsaved_runs_write_nothing_saved_runs_write_only_scenario_runs(db_session):
    _run(db_session, baseline_offset=2)
    assert db_session.query(ScenarioRun).count() == 0

    saved = _run(db_session, baseline_offset=2, save=True, label="warm room", created_by="ops")
    assert saved["saved_run_id"] is not None and db_session.query(ScenarioRun).count() == 1
    assert list_runs(db_session)[0]["label"] == "warm room"
    assert (
        get_run(db_session, saved["saved_run_id"])["assumptions"]["parameters"]["baseline_offset"]
        == 2
    )
    assert get_run(db_session, 9999) is None


def test_same_inputs_give_identical_output(db_session):
    a = _run(db_session, baseline_offset=3, variation_scale=1.5)
    b = _run(db_session, baseline_offset=3, variation_scale=1.5)
    assert a["results"] == b["results"]


def test_baseline_series_does_not_depend_on_scenario_parameters(db_session):
    a = _run(db_session, baseline_offset=0)["results"][0]["baseline"]
    b = _run(db_session, baseline_offset=8, variation_scale=4)["results"][0]["baseline"]
    assert a == b


def test_baseline_offset_shifts_the_scenario_by_exactly_that_much(db_session):
    r = _run(db_session, baseline_offset=4)["results"][0]
    assert r["delta"]["mean"] == pytest.approx(4.0, abs=0.2)  # shared noise: pure offset
    assert r["applied"]["baseline"] == 26.0 and r["applied"]["configured_baseline"] == 22.0
    assert len(r["baseline"]) == len(r["scenario"]) == 60


def test_zero_variation_gives_a_flat_series(db_session):
    r = _run(db_session, variation_scale=0)["results"][0]
    assert set(_vals(r["scenario"])) == {22.0}
    assert len(set(_vals(r["baseline"]))) > 1  # the unmodified model does vary


def test_power_setpoint_applies_to_power_sensors_only(db_session):
    r = _run(db_session, sensor_id="power-meter-f0", power_setpoint_kw=30.0)["results"][0]
    assert r["delta"]["scenario_mean"] > r["delta"]["baseline_mean"] + 5
    t = _run(db_session, sensor_id="temp-sensor-101", power_setpoint_kw=30.0)["results"][0]
    assert t["delta"]["max_abs"] == 0.0  # irrelevant parameter: no effect


def test_floor_scenario_runs_every_sensor_on_the_floor(db_session):
    body = run_scenario(db_session, floor=0, baseline_offset=1, window_minutes=30, start=START)
    assert {r["sensor_id"] for r in body["results"]} == {
        "temp-sensor-101",
        "temp-sensor-102",
        "temp-sensor-103",
        "temp-sensor-104",
        "power-meter-f0",
    }


def test_assumptions_are_complete_and_advisory_is_explicit(db_session):
    body = _run(db_session, baseline_offset=1)
    a = body["assumptions"]
    assert a["seed"] == 42 and a["step_seconds"] == 60 and a["window_minutes"] == 60
    assert a["parameters"] == {
        "baseline_offset": 1,
        "variation_scale": 1.0,
        "power_setpoint_kw": None,
    }
    assert "not a control action" in body["advisory"]


@pytest.mark.parametrize(
    "kwargs, error",
    [
        ({"baseline_offset": 11}, ValueError),
        ({"baseline_offset": -11}, ValueError),
        ({"variation_scale": 6}, ValueError),
        ({"power_setpoint_kw": 61}, ValueError),
        ({"window_minutes": 0}, ValueError),
        ({"window_minutes": 1441}, ValueError),
        ({"sensor_id": None}, ValueError),  # neither target
        ({"floor": 0}, ValueError),  # both targets
        ({"sensor_id": "nope"}, LookupError),
        ({"sensor_id": None, "floor": 9}, LookupError),
    ],
)
def test_out_of_bounds_and_bad_targets_are_rejected(db_session, kwargs, error):
    with pytest.raises(error):
        _run(db_session, **kwargs)


def test_clamping_is_reported_not_hidden(db_session):
    r = _run(db_session, baseline_offset=10, variation_scale=5, window_minutes=240)["results"][0]
    assert r["clamped_steps"]["scenario"] > 0
    assert max(_vals(r["scenario"])) <= 35.0


# --- the shared model itself -------------------------------------------------------
def test_simulate_series_is_deterministic_and_bounded():
    kw = {
        "sensor_id": "s",
        "sensor_type": "temperature",
        "baseline": 22.0,
        "variation": 1.5,
        "low": 18.0,
        "high": 35.0,
        "seed": 7,
        "start": START,
        "steps": 500,
        "step_seconds": 5,
    }
    a, b = sim_model.simulate_series(**kw), sim_model.simulate_series(**kw)
    assert a == b
    assert all(18.0 <= v <= 35.0 for _, v in a)
    other = sim_model.simulate_series(**{**kw, "seed": 8})
    assert [v for _, v in other] != [v for _, v in a]


def test_mean_reversion_keeps_the_walk_near_baseline():
    series = sim_model.simulate_series(
        sensor_id="s",
        sensor_type="temperature",
        baseline=22.0,
        variation=1.5,
        low=0.0,
        high=60.0,
        seed=1,
        start=START,
        steps=5000,
        step_seconds=5,
    )
    mean = sum(v for _, v in series) / len(series)
    assert mean == pytest.approx(22.0, abs=0.5)


def test_power_follows_the_occupancy_profile():
    assert sim_model.occupancy_factor(12.0) == 1.0
    assert sim_model.occupancy_factor(3.0) == 0.45
    assert 0.45 < sim_model.occupancy_factor(7.5) < 1.0
    day = sim_model.simulate_series(
        sensor_id="p",
        sensor_type="power_kw",
        baseline=14.0,
        variation=0.1,
        low=0,
        high=40,
        seed=1,
        start=datetime(2026, 3, 2, 6, 30, tzinfo=UTC),
        steps=2,
        step_seconds=3600 * 6,
        tz_name="UTC",
    )
    assert day[1][1] > day[0][1] * 1.5  # 12:30 local vs 06:30 local
