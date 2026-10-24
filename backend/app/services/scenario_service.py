"""Scenario lab: advisory what-if simulation. Never touches live telemetry.

A run re-simulates the seeded sensor model twice over the same window - once with the
sensor's configured parameters (baseline) and once with the user's overrides (scenario) -
entirely in memory. Both runs consume identical RNG noise, so every difference in the
output is caused by the parameters and nothing else. Only an explicit save writes to
`scenario_runs`; `sensor_readings` is never written.
"""

import json
from app.core.config import settings
from app.core.timeutil import iso
from app.models.scenario import ScenarioRun
from app.models.topology import Building, Sensor
from app.services import sim_model
from datetime import UTC, datetime
from sqlalchemy.orm import Session

ADVISORY = "Simulation — not a control action. Nothing here is sent to any equipment."


def _check_range(name: str, value: float, bounds: tuple[float, float]) -> None:
    if not bounds[0] <= value <= bounds[1]:
        raise ValueError(f"{name} must be between {bounds[0]} and {bounds[1]} (got {value})")


def _stats(baseline: list[float], scenario: list[float]) -> dict:
    deltas = [s - b for b, s in zip(baseline, scenario, strict=True)]
    n = len(deltas) or 1
    return {
        "mean": round(sum(deltas) / n, 3),
        "min": round(min(deltas, default=0.0), 3),
        "max": round(max(deltas, default=0.0), 3),
        "max_abs": round(max((abs(d) for d in deltas), default=0.0), 3),
        "baseline_mean": round(sum(baseline) / n, 3),
        "scenario_mean": round(sum(scenario) / n, 3),
    }


def _count_clamped(values: list[float], low: float, high: float) -> int:
    return sum(1 for v in values if v <= low or v >= high)


def run_scenario(
    db: Session,
    *,
    sensor_id: str | None = None,
    floor: int | None = None,
    baseline_offset: float = 0.0,
    variation_scale: float = 1.0,
    power_setpoint_kw: float | None = None,
    window_minutes: int = 120,
    start: datetime | None = None,
    label: str | None = None,
    save: bool = False,
    created_by: str | None = None,
) -> dict:
    bounds = settings.scenario
    if (sensor_id is None) == (floor is None):
        raise ValueError("Provide exactly one of sensor_id or floor")
    _check_range("baseline_offset", baseline_offset, bounds.baseline_offset)
    _check_range("variation_scale", variation_scale, bounds.variation_scale)
    if power_setpoint_kw is not None:
        _check_range("power_setpoint_kw", power_setpoint_kw, bounds.power_setpoint_kw)
    if not 1 <= window_minutes <= bounds.max_window_minutes:
        raise ValueError(f"window_minutes must be between 1 and {bounds.max_window_minutes}")

    sensors = db.query(Sensor).filter(Sensor.enabled.is_(True)).order_by(Sensor.sensor_id).all()
    if sensor_id is not None:
        sensors = [s for s in sensors if s.sensor_id == sensor_id]
        if not sensors:
            raise LookupError(f"Unknown or disabled sensor: {sensor_id}")
    else:
        sensors = [s for s in sensors if s.floor_level == floor]
        if not sensors:
            raise LookupError(f"No sensors on floor {floor}")
    sensors = [s for s in sensors if s.baseline is not None]

    step = bounds.step_seconds
    steps = max(2, (window_minutes * 60) // step)
    start = (start or datetime.now(UTC)).astimezone(UTC).replace(second=0, microsecond=0)
    building = db.query(Building).order_by(Building.id).first()
    tz_name = building.timezone if building else "UTC"
    seed = settings.simulator.seed

    results = []
    for s in sensors:
        is_power = s.type in sim_model.POWER_TYPES
        common = {
            "sensor_id": s.sensor_id,
            "sensor_type": s.type,
            "low": s.min_value,
            "high": s.max_value,
            "seed": seed,
            "start": start,
            "steps": steps,
            "step_seconds": step,
            "tz_name": tz_name,
        }
        base_series = sim_model.simulate_series(
            baseline=s.baseline, variation=s.variation, **common
        )
        new_baseline = (
            power_setpoint_kw if (is_power and power_setpoint_kw is not None) else s.baseline
        )
        if not is_power:
            new_baseline = s.baseline + baseline_offset
        new_variation = s.variation * variation_scale
        scen_series = sim_model.simulate_series(
            baseline=new_baseline, variation=new_variation, **common
        )

        b_vals = [v for _, v in base_series]
        s_vals = [v for _, v in scen_series]
        results.append(
            {
                "sensor_id": s.sensor_id,
                "location": s.location_code,
                "type": s.type,
                "unit": s.unit,
                "baseline": [{"t": iso(t), "v": v} for t, v in base_series],
                "scenario": [{"t": iso(t), "v": v} for t, v in scen_series],
                "delta": _stats(b_vals, s_vals),
                "clamped_steps": {
                    "baseline": _count_clamped(b_vals, s.min_value, s.max_value),
                    "scenario": _count_clamped(s_vals, s.min_value, s.max_value),
                },
                "applied": {
                    "baseline": round(new_baseline, 3),
                    "variation": round(new_variation, 3),
                    "configured_baseline": s.baseline,
                    "configured_variation": s.variation,
                },
            }
        )

    assumptions = {
        "model": "seeded mean-reverting temperature walk; occupancy-profiled electrical load",
        "seed": seed,
        "rng": "per-sensor seed '<seed>:<sensor_id>'; baseline and scenario share identical noise",
        "step_seconds": step,
        "steps": steps,
        "window_minutes": window_minutes,
        "start": iso(start),
        "timezone": tz_name,
        "parameters": {
            "baseline_offset": baseline_offset,
            "variation_scale": variation_scale,
            "power_setpoint_kw": power_setpoint_kw,
        },
        "notes": [
            "baseline_offset applies to temperature sensors; power_setpoint_kw applies to power_kw sensors.",
            "Values are clamped to each sensor's configured min/max (see clamped_steps).",
            "Weather, occupancy changes and equipment dynamics are not modelled.",
        ],
    }
    payload = {
        "mode": "scenario",
        "advisory": ADVISORY,
        "label": label,
        "target": {"sensor_id": sensor_id, "floor": floor},
        "assumptions": assumptions,
        "results": results,
        "saved_run_id": None,
    }

    if save:
        run = ScenarioRun(
            label=label,
            created_by=created_by,
            sensor_id=sensor_id or f"floor:{floor}",
            parameters_json=json.dumps(assumptions["parameters"] | {"target": payload["target"]}),
            result_json=json.dumps(payload),
        )
        db.add(run)
        db.commit()
        payload["saved_run_id"] = run.id
    return payload


def list_runs(db: Session, limit: int = 50) -> list[dict]:
    rows = db.query(ScenarioRun).order_by(ScenarioRun.id.desc()).limit(limit).all()
    return [
        {
            "id": r.id,
            "label": r.label,
            "created_by": r.created_by,
            "created_at": iso(r.created_at),
            "sensor_id": r.sensor_id,
            "parameters": json.loads(r.parameters_json),
        }
        for r in rows
    ]


def get_run(db: Session, run_id: int) -> dict | None:
    r = db.get(ScenarioRun, run_id)
    if r is None:
        return None
    payload = json.loads(r.result_json)
    payload["saved_run_id"] = r.id
    return payload


__all__ = ["ADVISORY", "get_run", "list_runs", "run_scenario"]
