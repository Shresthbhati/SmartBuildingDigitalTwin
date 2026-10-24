"""Anticipate: rule-based maintenance flags, an honest short-horizon trend, and energy summaries.

Everything here is labelled for what it is:
  * flags are "rule-based (v1)": counting rules over persisted alerts/anomalies/readings,
    each carrying links to the evidence. No ML and no failure-date prediction.
  * the forecast is a linear trend labelled "estimated", with an error band from residuals,
    and it abstains when data is stale or sparse rather than extrapolating from nothing.
  * energy is computed from the *simulated* meters and says so.
"""

import math
from app.core.config import settings
from app.core.timeutil import as_utc, iso
from app.models.alert import Alert, AlertType
from app.models.anomaly import AnomalyEvent
from app.models.sensor import SensorReading
from app.models.topology import Sensor
from app.services import timeseries
from datetime import UTC, datetime, timedelta
from sqlalchemy import func
from sqlalchemy.orm import Session

BASIS = "rule-based (v1)"
FLAPPING_TYPES = (AlertType.STALE_SENSOR, AlertType.CONNECTIVITY_LOSS, AlertType.INVALID_READING)
ENERGY_BUCKET_SECONDS = 300


def _val(x):
    return getattr(x, "value", x)


# --------------------------------------------------------------------------- #
# Maintenance flags                                                           #
# --------------------------------------------------------------------------- #
def compute_flags(db: Session, now: datetime | None = None) -> dict:
    cfg = settings.maintenance
    now = as_utc(now) if now else datetime.now(UTC)
    since = now - timedelta(days=cfg.lookback_days)
    stale_after = timedelta(seconds=settings.alerts.stale_sensor_seconds)
    warn = settings.alerts.temperature.warning

    flags: list[dict] = []
    for s in db.query(Sensor).filter(Sensor.enabled.is_(True)).order_by(Sensor.sensor_id).all():
        location = s.location_code

        def flag(rule, severity, summary, evidence, links, s=s, location=location):
            flags.append(
                {
                    "sensor_id": s.sensor_id,
                    "location": location,
                    "asset": s.asset.code if s.asset else None,
                    "rule": rule,
                    "severity": severity,
                    "summary": summary,
                    "evidence": evidence,
                    "evidence_links": links,
                    "basis": BASIS,
                }
            )

        anomalies = (
            db.query(AnomalyEvent)
            .filter(AnomalyEvent.sensor_id == s.sensor_id, AnomalyEvent.detected_at >= since)
            .order_by(AnomalyEvent.detected_at)
            .all()
        )
        if len(anomalies) >= cfg.anomaly_count_flag:
            flag(
                "anomaly_frequency",
                "attention",
                f"{len(anomalies)} statistical anomalies in {cfg.lookback_days} days",
                {
                    "count": len(anomalies),
                    "threshold": cfg.anomaly_count_flag,
                    "lookback_days": cfg.lookback_days,
                },
                [{"kind": "anomaly", "id": a.id} for a in anomalies[-10:]],
            )

        alerts = (
            db.query(Alert)
            .filter(Alert.first_occurrence >= since)
            .filter(
                (Alert.sensor_id == s.sensor_id)
                | ((Alert.sensor_id == "") & (Alert.room == location))
            )
            .order_by(Alert.first_occurrence)
            .all()
        )
        by_type: dict[str, list[Alert]] = {}
        for a in alerts:
            by_type.setdefault(_val(a.alert_type), []).append(a)
        for atype, group in by_type.items():
            if AlertType(atype) in FLAPPING_TYPES:
                continue
            if len(group) >= cfg.alert_recurrence_flag:
                flag(
                    "alert_recurrence",
                    "attention",
                    f"'{atype}' alert raised {len(group)} times in {cfg.lookback_days} days",
                    {
                        "alert_type": atype,
                        "count": len(group),
                        "threshold": cfg.alert_recurrence_flag,
                    },
                    [{"kind": "alert", "id": a.id} for a in group[-10:]],
                )
        flapping = [a for a in alerts if a.alert_type in FLAPPING_TYPES]
        if len(flapping) >= cfg.flapping_transitions:
            flag(
                "sensor_flapping",
                "attention",
                f"Sensor dropped out or misreported {len(flapping)} times in {cfg.lookback_days} days",
                {"count": len(flapping), "threshold": cfg.flapping_transitions},
                [{"kind": "alert", "id": a.id} for a in flapping[-10:]],
            )

        if s.type == "temperature":
            total = (
                db.query(func.count(SensorReading.id))
                .filter(
                    SensorReading.sensor_id == s.sensor_id, SensorReading.event_timestamp >= since
                )
                .scalar()
            )
            over = (
                db.query(func.count(SensorReading.id))
                .filter(
                    SensorReading.sensor_id == s.sensor_id,
                    SensorReading.event_timestamp >= since,
                    SensorReading.value > warn,
                )
                .scalar()
            )
            ratio = (over / total) if total else 0.0
            if total and ratio >= cfg.time_in_warning_ratio:
                flag(
                    "time_in_warning",
                    "watch",
                    f"{ratio:.0%} of readings above the {warn}°C warning threshold",
                    {
                        "ratio": round(ratio, 3),
                        "readings_over": over,
                        "readings_total": total,
                        "warning_threshold": warn,
                    },
                    [],
                )

        if s.last_seen_at is not None and now - as_utc(s.last_seen_at) > stale_after:
            flag(
                "stale_now",
                "watch",
                "No telemetry within the stale window",
                {
                    "last_seen_at": iso(s.last_seen_at),
                    "stale_after_seconds": int(stale_after.total_seconds()),
                },
                [],
            )

    return {
        "basis": BASIS,
        "disclaimer": "Counting rules over recorded alerts, anomalies and readings. "
        "Not a prediction of failure and not a failure date.",
        "generated_at": now.isoformat(),
        "lookback_days": cfg.lookback_days,
        "flags": flags,
    }


# --------------------------------------------------------------------------- #
# Trend forecast                                                              #
# --------------------------------------------------------------------------- #
def forecast(
    db: Session, sensor_id: str, horizon_minutes: int = 30, now: datetime | None = None
) -> dict:
    cfg = settings.maintenance
    now = as_utc(now) if now else datetime.now(UTC)
    sensor = db.query(Sensor).filter(Sensor.sensor_id == sensor_id).first()
    if sensor is None:
        raise LookupError(f"Unknown sensor: {sensor_id}")

    base = {
        "sensor_id": sensor_id,
        "label": "estimated",
        "method": "linear trend (ordinary least squares) over recent readings",
        "horizon_minutes": horizon_minutes,
        "unit": sensor.unit,
        "stale_after_seconds": settings.alerts.stale_sensor_seconds,
        "generated_at": now.isoformat(),
    }

    since = now - timedelta(minutes=cfg.forecast_lookback_minutes)
    rows = (
        db.query(SensorReading.event_timestamp, SensorReading.value)
        .filter(SensorReading.sensor_id == sensor_id, SensorReading.event_timestamp >= since)
        .order_by(SensorReading.event_timestamp)
        .all()
    )
    if len(rows) < cfg.forecast_min_points:
        return {
            **base,
            "abstained": True,
            "reason": "sparse",
            "detail": f"{len(rows)} readings; need {cfg.forecast_min_points}",
            "points": [],
        }

    pts = [(as_utc(t).timestamp(), v) for t, v in rows]
    last_t = pts[-1][0]
    if now.timestamp() - last_t > settings.alerts.stale_sensor_seconds:
        return {
            **base,
            "abstained": True,
            "reason": "stale",
            "detail": "latest reading is older than the stale window",
            "points": [],
        }

    n = len(pts)
    xs = [t - last_t for t, _ in pts]  # seconds relative to the latest reading
    ys = [v for _, v in pts]
    x_mean, y_mean = sum(xs) / n, sum(ys) / n
    sxx = sum((x - x_mean) ** 2 for x in xs)
    if sxx == 0:
        return {
            **base,
            "abstained": True,
            "reason": "sparse",
            "detail": "readings share one timestamp",
            "points": [],
        }
    slope = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys, strict=True)) / sxx
    intercept = y_mean - slope * x_mean
    residuals = [y - (intercept + slope * x) for x, y in zip(xs, ys, strict=True)]
    resid_std = math.sqrt(sum(r * r for r in residuals) / max(n - 2, 1))

    horizon_s = horizon_minutes * 60
    step_s = max(60, horizon_s // 10)
    out = []
    for k in range(1, horizon_s // step_s + 1):
        x = k * step_s
        value = intercept + slope * x
        # 95% prediction interval for a new observation at x
        band = 1.96 * resid_std * math.sqrt(1 + 1 / n + (x - x_mean) ** 2 / sxx)
        out.append(
            {
                "t": datetime.fromtimestamp(last_t + x, UTC).isoformat(),
                "v": round(value, 3),
                "lo": round(value - band, 3),
                "hi": round(value + band, 3),
            }
        )
    return {
        **base,
        "abstained": False,
        "reason": None,
        "based_on": {
            "n": n,
            "from": datetime.fromtimestamp(pts[0][0], UTC).isoformat(),
            "to": datetime.fromtimestamp(last_t, UTC).isoformat(),
        },
        "slope_per_hour": round(slope * 3600, 4),
        "residual_std": round(resid_std, 4),
        "points": out,
    }


# --------------------------------------------------------------------------- #
# Energy                                                                      #
# --------------------------------------------------------------------------- #
def energy_summary(db: Session, start: datetime, end: datetime) -> dict:
    start, end = as_utc(start), as_utc(end)
    if end <= start:
        raise ValueError("end must be after start")
    total_buckets = max(1, math.ceil((end - start).total_seconds() / ENERGY_BUCKET_SECONDS))
    bucket_hours = ENERGY_BUCKET_SECONDS / 3600

    meters = []
    for s in db.query(Sensor).filter(Sensor.type == "power_kw").order_by(Sensor.sensor_id).all():
        buckets = timeseries.bucketed(db, s.sensor_id, start, end, ENERGY_BUCKET_SECONDS)
        kwh = sum(b["avg"] * bucket_hours for b in buckets)
        peak_row = (
            db.query(SensorReading.value, SensorReading.event_timestamp)
            .filter(
                SensorReading.sensor_id == s.sensor_id,
                SensorReading.event_timestamp >= start,
                SensorReading.event_timestamp <= end,
            )
            .order_by(SensorReading.value.desc())
            .first()
        )
        meters.append(
            {
                "sensor_id": s.sensor_id,
                "location": s.location_code,
                "floor": s.floor_level,
                "source": s.source,
                "label": "simulated" if s.source == "simulated" else "measured",
                "kwh": round(kwh, 3),
                "avg_kw": round(kwh / (len(buckets) * bucket_hours), 3) if buckets else None,
                "peak_kw": round(peak_row[0], 3) if peak_row else None,
                "peak_at": iso(peak_row[1]) if peak_row else None,
                "coverage": round(len(buckets) / total_buckets, 3),
                "series": [{"t": iso(b["t"]), "kw": round(b["avg"], 3)} for b in buckets],
            }
        )
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "bucket_seconds": ENERGY_BUCKET_SECONDS,
        "note": "kW is instantaneous power; kWh is energy = kW integrated over time. "
        "Buckets without readings contribute nothing (see coverage), they are not interpolated.",
        "meters": meters,
        "total_kwh": round(sum(m["kwh"] for m in meters), 3),
        "peak_kw_total": round(max((m["peak_kw"] or 0 for m in meters), default=0), 3),
    }
