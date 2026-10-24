"""NEXUS endpoints: auth, metadata, topology, replay, investigation, scenarios, anticipate."""

import time
from app.core.config import settings
from app.core.database import get_db
from app.core.security import Principal, authenticate, create_token, get_principal, require_operator
from app.core.timeutil import iso
from app.models.sensor import SensorReading
from app.services import (
    context_service,
    maintenance_service,
    replay_service,
    scenario_service,
    topology_service,
)
from app.services.simulator_service import INJECTION_KINDS, sensor_simulator
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

router = APIRouter()

# --------------------------------------------------------------------- #
# Auth                                                                  #
# --------------------------------------------------------------------- #
_MAX_FAILURES = 5
_FAILURE_WINDOW_S = 60
_failures: dict[str, deque] = defaultdict(deque)


class LoginRequest(BaseModel):
    username: str = Field(max_length=100)
    password: str = Field(max_length=200)


@router.post("/api/auth/login")
def login(body: LoginRequest):
    if not settings.auth.enabled:
        raise HTTPException(status_code=400, detail="Authentication is disabled")
    # Throttle guessing per username: 5 failures per minute.
    window = _failures[body.username]
    now = time.monotonic()
    while window and now - window[0] > _FAILURE_WINDOW_S:
        window.popleft()
    if len(window) >= _MAX_FAILURES:
        raise HTTPException(status_code=429, detail="Too many failed attempts; try again shortly")

    principal = authenticate(body.username, body.password)
    if principal is None:
        window.append(now)
        raise HTTPException(status_code=401, detail="Invalid username or password")
    window.clear()
    token, expires_in = create_token(principal)
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": expires_in,
        "username": principal.username,
        "role": principal.role,
    }


@router.get("/api/auth/me")
def whoami(principal: Principal = Depends(get_principal)):
    return {
        "username": principal.username,
        "role": principal.role,
        "auth_enabled": settings.auth.enabled,
    }


@router.get("/api/meta")
def meta():
    """Server-side facts the UI needs to label things honestly (thresholds, bounds, limits)."""
    sc = settings.scenario
    return {
        "auth_enabled": settings.auth.enabled,
        "stale_after_seconds": settings.alerts.stale_sensor_seconds,
        "retention_days": settings.retention.raw_telemetry_days,
        "simulator": {
            "enabled": settings.simulator.enabled,
            "interval_seconds": settings.simulator.interval_seconds,
            "transport": settings.simulator.transport,
            "injection_kinds": list(INJECTION_KINDS),
        },
        "thresholds": {
            "warning": settings.alerts.temperature.warning,
            "critical": settings.alerts.temperature.critical,
            "recovery": settings.alerts.temperature.recovery,
        },
        "anomaly_detection": {
            "z_score_threshold": settings.anomaly_detection.z_score_threshold,
            "spike_threshold": settings.anomaly_detection.spike_threshold,
            "rolling_window_size": settings.anomaly_detection.rolling_window_size,
        },
        "scenario_bounds": {
            "max_window_minutes": sc.max_window_minutes,
            "step_seconds": sc.step_seconds,
            "baseline_offset": list(sc.baseline_offset),
            "variation_scale": list(sc.variation_scale),
            "power_setpoint_kw": list(sc.power_setpoint_kw),
        },
        "replay": {
            "max_points_per_sensor": settings.replay.max_points_per_sensor,
            "event_limit": settings.replay.event_limit,
        },
    }


# --------------------------------------------------------------------- #
# Topology                                                              #
# --------------------------------------------------------------------- #
@router.get("/api/topology")
def get_topology(db: Session = Depends(get_db)):
    return topology_service.get_topology_tree(db)


@router.get("/api/sensors")
def get_sensors(db: Session = Depends(get_db)):
    return topology_service.list_sensors(db)


@router.get("/api/readings/latest")
def get_latest_readings(db: Session = Depends(get_db)):
    """Most recently ingested reading per sensor, with its real event timestamp and source."""
    newest = db.query(func.max(SensorReading.id)).group_by(SensorReading.sensor_id)
    rows = db.query(SensorReading).filter(SensorReading.id.in_(newest)).all()
    return [
        {
            "sensor_id": r.sensor_id,
            "room": r.room,
            "measurement": r.measurement,
            "value": r.value,
            "unit": r.unit,
            "source": r.source.value,
            "event_timestamp": iso(r.event_timestamp),
        }
        for r in rows
    ]


# --------------------------------------------------------------------- #
# Replay (Building Time Travel) and investigation                       #
# --------------------------------------------------------------------- #
@router.get("/api/replay")
def get_replay(
    start: datetime = Query(...),
    end: datetime = Query(...),
    floor: int | None = Query(default=None),
    max_points: int | None = Query(default=None, ge=10, le=5000),
    event_limit: int | None = Query(default=None, ge=1, le=2000),
    event_offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    try:
        return replay_service.build_replay(
            db, start, end, floor, max_points, event_limit, event_offset
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


@router.get("/api/anomalies/{anomaly_id}/context")
def get_anomaly_context(
    anomaly_id: int,
    window_minutes: int | None = Query(default=None, ge=1, le=120),
    db: Session = Depends(get_db),
):
    ctx = context_service.build_anomaly_context(db, anomaly_id, window_minutes)
    if ctx is None:
        raise HTTPException(status_code=404, detail=f"Anomaly {anomaly_id} not found")
    return ctx


# --------------------------------------------------------------------- #
# Scenario lab + live injection                                         #
# --------------------------------------------------------------------- #
class ScenarioRunRequest(BaseModel):
    sensor_id: str | None = None
    floor: int | None = None
    baseline_offset: float = 0.0
    variation_scale: float = 1.0
    power_setpoint_kw: float | None = None
    window_minutes: int = 120
    start: datetime | None = None
    label: str | None = Field(default=None, max_length=200)
    save: bool = False


@router.post("/api/scenarios/run")
def run_scenario(
    body: ScenarioRunRequest,
    principal: Principal = Depends(require_operator),
    db: Session = Depends(get_db),
):
    try:
        return scenario_service.run_scenario(db, **body.model_dump(), created_by=principal.username)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None


@router.get("/api/scenarios")
def list_scenarios(limit: int = Query(default=50, ge=1, le=200), db: Session = Depends(get_db)):
    return scenario_service.list_runs(db, limit)


@router.get("/api/scenarios/{run_id}")
def get_scenario(run_id: int, db: Session = Depends(get_db)):
    run = scenario_service.get_run(db, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Scenario run {run_id} not found")
    return run


class InjectRequest(BaseModel):
    sensor_id: str
    kind: str
    duration_seconds: int = Field(default=30, ge=1, le=3600)
    magnitude: float | None = Field(default=None, ge=-50, le=50)


@router.post("/api/simulator/inject")
def inject_scenario(body: InjectRequest, _principal: Principal = Depends(require_operator)):
    """Demo/E2E hook: make a simulated sensor misbehave. Readings are tagged source=scenario."""
    try:
        return sensor_simulator.inject(
            body.sensor_id, body.kind, body.duration_seconds, body.magnitude
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e)) from None


# --------------------------------------------------------------------- #
# Anticipate                                                            #
# --------------------------------------------------------------------- #
@router.get("/api/maintenance")
def get_maintenance(db: Session = Depends(get_db)):
    return maintenance_service.compute_flags(db)


@router.get("/api/forecast")
def get_forecast(
    sensor_id: str,
    horizon_minutes: int = Query(default=30, ge=5, le=240),
    db: Session = Depends(get_db),
):
    try:
        return maintenance_service.forecast(db, sensor_id, horizon_minutes)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from None


@router.get("/api/energy")
def get_energy(
    start: datetime | None = None,
    end: datetime | None = None,
    db: Session = Depends(get_db),
):
    end = end or datetime.now(UTC)
    start = start or end - timedelta(hours=24)
    try:
        return maintenance_service.energy_summary(db, start, end)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
