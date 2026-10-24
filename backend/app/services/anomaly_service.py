import json
import logging
import math
import threading
import time
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.timeutil import as_utc
from app.models.anomaly import (
    AnomalyCategory,
    AnomalyEvent,
    AnomalySeverity,
    AnomalyStatus,
)
from app.models.sensor import SensorReading
from app.services.lifecycle import track_transition
from datetime import UTC, datetime, timedelta
from sqlalchemy import desc, func
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# Floor for the baseline standard deviation: sensors report to 0.1 resolution, so a
# perfectly flat window must not turn a 0.1 wiggle into a huge z-score.
MIN_STDDEV = 0.1

_SEVERITY_RANK = {AnomalySeverity.INFO: 0, AnomalySeverity.WARNING: 1, AnomalySeverity.CRITICAL: 2}


class RollingWindowCache:
    """Thread-safe rolling window of recent readings per (room, sensor_id).

    Maintains a bounded list of (timestamp, value) tuples. On restart,
    the cache can be rebuilt from the database via `load_from_db`.
    """

    def __init__(self, window_size: int = 20):
        self.window_size = window_size
        self._lock = threading.Lock()
        # Key: (room, sensor_id) -> list of (event_timestamp, value)
        self._windows: dict[tuple[str, str], list[tuple[datetime, float]]] = {}
        # Track when each sensor first saw a reading (for warm-up)
        self._first_seen: dict[tuple[str, str], datetime] = {}

    def add(self, room: str, sensor_id: str, timestamp: datetime, value: float):
        key = (room, sensor_id)
        timestamp = as_utc(timestamp)
        with self._lock:
            if key not in self._windows:
                self._windows[key] = []
                self._first_seen[key] = timestamp
            window = self._windows[key]
            window.append((timestamp, value))
            if len(window) > self.window_size:
                window.pop(0)

    def get_window(self, room: str, sensor_id: str) -> list[tuple[datetime, float]]:
        with self._lock:
            return list(self._windows.get((room, sensor_id), []))

    def get_first_seen(self, room: str, sensor_id: str) -> datetime | None:
        with self._lock:
            return self._first_seen.get((room, sensor_id))

    def load_from_db(self, db: Session, limit_per_sensor: int | None = None):
        """Rebuild rolling windows from historical readings.

        Queries the most recent readings per sensor to reconstruct the
        baseline after a backend restart.
        """

        limit = limit_per_sensor or self.window_size
        pairs = (
            db.query(SensorReading.room, SensorReading.sensor_id)
            .filter(SensorReading.measurement == "temperature")
            .distinct()
            .all()
        )
        for room, sensor_id in pairs:
            readings = (
                db.query(SensorReading.event_timestamp, SensorReading.value)
                .filter(SensorReading.room == room)
                .filter(SensorReading.sensor_id == sensor_id)
                .filter(SensorReading.measurement == "temperature")
                .order_by(desc(SensorReading.event_timestamp))
                .limit(limit)
                .all()
            )
            if not readings:
                continue
            # Reverse so oldest first
            window = [(as_utc(r.event_timestamp), r.value) for r in reversed(readings)]
            key = (room, sensor_id)
            with self._lock:
                self._windows[key] = window
                self._first_seen[key] = window[0][0]

    def clear(self):
        with self._lock:
            self._windows.clear()
            self._first_seen.clear()


class AnomalyService:
    """Lightweight statistical anomaly detection engine.

    Uses rolling per-sensor baselines (mean + standard deviation) to detect
    statistically unusual readings without ML frameworks. Supports:

    - Z-score spike detection (value far above baseline)
    - Z-score drop detection (value far below baseline)
    - Moderate z-score deviation (labelled `sustained_deviation`)
    - Cooldown/deduplication to avoid duplicate events during sustained conditions
    - Recovery detection when readings return to acceptable range
    - Warm-up period to avoid false positives during sensor initialization

    The baseline is computed from readings *before* the one being judged, and flagged
    readings are kept out of the baseline, so an outlier cannot dilute its own z-score.
    """

    def __init__(self):
        self.running = False
        self.thread: threading.Thread | None = None
        self.last_run: datetime | None = None
        self.last_error: str | None = None
        self._lock = threading.RLock()

        self._cache = RollingWindowCache(window_size=settings.anomaly_detection.rolling_window_size)

        # Active anomalies for deduplication. Only ids are cached: ORM objects would be
        # detached/expired once the session that loaded them closes.
        # Key: (room, sensor_id, anomaly_category) -> AnomalyEvent.id
        self._active: dict[tuple[str, str, str], int] = {}
        # Cooldown tracking: wall-clock time of the last creation per key
        self._last_anomaly_time: dict[tuple[str, str, str], datetime] = {}
        # Consecutive moderate-deviation readings per (room, sensor_id)
        self._streaks: dict[tuple[str, str], int] = {}

    # ------------------------------------------------------------------ #
    # Lifecycle                                                          #
    # ------------------------------------------------------------------ #
    def start(self):
        if self.running:
            logger.warning("Anomaly service already running")
            return
        if not settings.anomaly_detection.enabled:
            logger.info("Anomaly detection disabled in config")
            return
        self.running = True
        db = SessionLocal()
        try:
            self._cache.load_from_db(db)
            self._load_active(db)
        finally:
            db.close()
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()
        logger.info(
            f"Anomaly detection service started: window={settings.anomaly_detection.rolling_window_size}, "
            f"z_threshold={settings.anomaly_detection.z_score_threshold}, "
            f"cooldown={settings.anomaly_detection.cooldown_seconds}s"
        )

    def stop(self):
        if not self.running:
            return
        self.running = False
        if self.thread:
            self.thread.join(timeout=10)
            self.thread = None
        logger.info("Anomaly detection service stopped")

    def _load_active(self, db: Session) -> None:
        """Re-adopt still-open anomalies after a restart so they are not duplicated."""
        rows = (
            db.query(AnomalyEvent)
            .filter(AnomalyEvent.status.in_([AnomalyStatus.OPEN, AnomalyStatus.ACKNOWLEDGED]))
            .all()
        )
        with self._lock:
            self._active = {(r.room, r.sensor_id, r.anomaly_category.value): r.id for r in rows}
            self._last_anomaly_time = {k: datetime.now(UTC) for k in self._active}

    def _run_loop(self):
        while self.running:
            start_time = time.time()
            try:
                self._evaluate_recovery()
                self.last_run = datetime.now(UTC)
            except Exception as e:
                logger.error(f"Error in anomaly recovery loop: {e}")
                with self._lock:
                    self.last_error = str(e)
            elapsed = time.time() - start_time
            sleep_seconds = max(0, settings.anomaly_detection.cooldown_seconds - elapsed)
            while sleep_seconds > 0 and self.running:
                sleep_chunk = min(5, sleep_seconds)
                time.sleep(sleep_chunk)
                sleep_seconds -= sleep_chunk

    # ------------------------------------------------------------------ #
    # Public evaluation entry point                                      #
    # ------------------------------------------------------------------ #
    def evaluate_reading(
        self,
        room: str,
        sensor_id: str,
        value: float,
        unit: str = "celsius",
        source: str = "simulated",
        event_timestamp: datetime | None = None,
        measurement: str = "temperature",
        db: Session | None = None,
    ) -> None:
        """Evaluate a single telemetry reading for anomalies.

        Idempotent and safe: failures do not propagate to the caller.
        Updates the rolling baseline and creates/resolves anomaly events.
        """
        if measurement != "temperature":
            return  # baselines and messages are temperature-specific

        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True

        event_timestamp = as_utc(event_timestamp) if event_timestamp else datetime.now(UTC)

        try:
            # 1. Skip invalid / non-finite readings - never treat missing data as zero
            if value is None or not math.isfinite(value):
                return

            # 2. Baseline from readings *before* this one
            prior = self._cache.get_window(room, sensor_id)
            warmed = self._is_warmed_up(room, sensor_id, event_timestamp, prior)
            baseline = self._compute_baseline(prior) if warmed else None

            if baseline is None:
                self._cache.add(room, sensor_id, event_timestamp, value)
                return

            mean, stddev, count = baseline
            classified = self._classify(value, mean, stddev)

            # A moderate deviation only counts once it has persisted: one noisy reading is
            # not a "sustained" anything. Pending readings stay out of the baseline.
            streak_key = (room, sensor_id)
            if classified and classified[0] == AnomalyCategory.SUSTAINED_DEVIATION:
                streak = self._streaks.get(streak_key, 0) + 1
                self._streaks[streak_key] = streak
                if streak < settings.anomaly_detection.sustained_min_readings:
                    return
            else:
                self._streaks[streak_key] = 0

            # 3. Flagged readings stay out of the baseline so it doesn't chase the anomaly
            if classified is None:
                self._cache.add(room, sensor_id, event_timestamp, value)
                self._check_recovery(db, room, sensor_id, value, mean, stddev)
            else:
                self._record_detection(
                    db,
                    room,
                    sensor_id,
                    value,
                    mean,
                    stddev,
                    count,
                    event_timestamp,
                    unit,
                    source,
                    classified,
                )
            db.commit()

        except Exception as e:
            db.rollback()
            logger.error(f"Anomaly evaluation failed for {room}/{sensor_id}: {e}")
        finally:
            if own_session:
                db.close()

    # ------------------------------------------------------------------ #
    # Recovery evaluation (periodic, no new telemetry needed)            #
    # ------------------------------------------------------------------ #
    def _evaluate_recovery(self):
        """Periodically check if any active anomalies should be resolved
        because readings have returned to acceptable range."""
        db = SessionLocal()
        try:
            with self._lock:
                active_keys = list(self._active.keys())

            for room, sensor_id, _category in set(active_keys):
                latest = (
                    db.query(SensorReading)
                    .filter(SensorReading.room == room)
                    .filter(SensorReading.sensor_id == sensor_id)
                    .filter(SensorReading.measurement == "temperature")
                    .order_by(desc(SensorReading.event_timestamp))
                    .first()
                )
                if not latest:
                    continue
                baseline = self._compute_baseline(self._cache.get_window(room, sensor_id))
                if baseline is None:
                    continue
                mean, stddev, _count = baseline
                self._check_recovery(db, room, sensor_id, latest.value, mean, stddev)

            db.commit()
        except Exception as e:
            db.rollback()
            logger.error(f"Error in anomaly recovery evaluation: {e}")
        finally:
            db.close()

    # ------------------------------------------------------------------ #
    # Internal detection helpers                                         #
    # ------------------------------------------------------------------ #
    def _is_warmed_up(
        self,
        room: str,
        sensor_id: str,
        now: datetime,
        window: list[tuple[datetime, float]] | None = None,
    ) -> bool:
        """Check if enough samples and warm-up time have elapsed."""
        if window is None:
            window = self._cache.get_window(room, sensor_id)
        if len(window) < settings.anomaly_detection.min_samples:
            return False

        first_seen = self._cache.get_first_seen(room, sensor_id)
        if first_seen is None:
            return False

        warm_up = timedelta(seconds=settings.anomaly_detection.warm_up_seconds)
        return as_utc(now) - first_seen >= warm_up

    def _compute_baseline(
        self, window: list[tuple[datetime, float]]
    ) -> tuple[float, float, int] | None:
        """Compute rolling mean, standard deviation, and count.

        Returns None if fewer than min_samples points.
        """
        if len(window) < settings.anomaly_detection.min_samples:
            return None

        values = [v for _, v in window]
        count = len(values)
        mean = sum(values) / count
        variance = sum((v - mean) ** 2 for v in values) / (count - 1)
        return mean, max(math.sqrt(variance), MIN_STDDEV), count

    def _classify(
        self, value: float, mean: float, stddev: float
    ) -> tuple[AnomalyCategory, AnomalySeverity, float] | None:
        """Map a reading to (category, severity, z-score) or None when within bounds."""
        cfg = settings.anomaly_detection
        signed = (value - mean) / stddev
        z = abs(signed)
        threshold = cfg.spike_threshold if signed > 0 else cfg.drop_threshold

        if z > threshold:
            category = AnomalyCategory.Z_SCORE_SPIKE if signed > 0 else AnomalyCategory.Z_SCORE_DROP
            severity = AnomalySeverity.CRITICAL if z > threshold * 1.5 else AnomalySeverity.WARNING
            return category, severity, z
        if z > cfg.z_score_threshold:
            return AnomalyCategory.SUSTAINED_DEVIATION, AnomalySeverity.WARNING, z
        return None

    def _record_detection(
        self,
        db: Session,
        room: str,
        sensor_id: str,
        value: float,
        mean: float,
        stddev: float,
        count: int,
        event_timestamp: datetime,
        unit: str,
        source: str,
        classified: tuple[AnomalyCategory, AnomalySeverity, float],
    ) -> None:
        category, severity, z = classified
        cfg = settings.anomaly_detection
        key = (room, sensor_id, category.value)
        cooldown = timedelta(seconds=cfg.cooldown_seconds)
        now = datetime.now(UTC)

        with self._lock:
            active_id = self._active.get(key)
            last_time = self._last_anomaly_time.get(key)

        existing = db.get(AnomalyEvent, active_id) if active_id is not None else None
        if existing is not None and existing.status == AnomalyStatus.RESOLVED:
            self._forget(existing)
            existing = None

        if existing is not None:
            if last_time and now - last_time < cooldown:
                # Same condition still ongoing: fold into the existing event.
                existing.last_observed_at = event_timestamp
                existing.observed_value = value
                existing.deviation_score = max(existing.deviation_score, z)
                if _SEVERITY_RANK[severity] > _SEVERITY_RANK[existing.severity]:
                    existing.severity = severity
                existing.occurrence_count = min(
                    existing.occurrence_count + 1, settings.alerts.max_occurrence_count
                )
                existing.updated_at = now
                return
            # Cooldown expired while still abnormal: close the old event, open a new one.
            self._resolve_anomaly_obj(db, existing, actor="system", at=event_timestamp)

        title, description = self._build_anomaly_message(
            room, sensor_id, category, severity, value, mean, z
        )
        metadata = {
            "detection_method": "z_score",
            "z_score": round(z, 4),
            "rolling_mean": round(mean, 4),
            "rolling_stddev": round(stddev, 4),
            "sample_count": count,
            "window_size": cfg.rolling_window_size,
            "threshold_used": cfg.spike_threshold
            if category == AnomalyCategory.Z_SCORE_SPIKE
            else cfg.drop_threshold
            if category == AnomalyCategory.Z_SCORE_DROP
            else cfg.z_score_threshold,
            "detector_config": {
                "z_score_threshold": cfg.z_score_threshold,
                "spike_threshold": cfg.spike_threshold,
                "drop_threshold": cfg.drop_threshold,
                "min_samples": cfg.min_samples,
                "cooldown_seconds": cfg.cooldown_seconds,
            },
            "unit": unit,
            "source": source,
        }
        anomaly = AnomalyEvent(
            room=room,
            sensor_id=sensor_id,
            anomaly_category=category,
            severity=severity,
            title=title,
            description=description,
            status=AnomalyStatus.OPEN,
            detected_at=event_timestamp,
            last_observed_at=event_timestamp,
            observed_value=value,
            expected_baseline=mean,
            deviation_score=z,
            occurrence_count=1,
            metadata_json=json.dumps(metadata),
        )
        db.add(anomaly)
        db.flush()
        track_transition(
            db, "anomaly", anomaly, None, AnomalyStatus.OPEN, "system", event_timestamp, "created"
        )
        with self._lock:
            self._active[key] = anomaly.id
            self._last_anomaly_time[key] = now

        logger.info(
            f"Anomaly created: {room}/{sensor_id} {category.value} {severity.value} (z={z:.2f})"
        )

    def _check_recovery(
        self,
        db: Session,
        room: str,
        sensor_id: str,
        value: float,
        mean: float,
        stddev: float,
    ):
        """Resolve active anomalies for this sensor once the reading is back near baseline."""
        # An anomaly is considered recovered when the reading is within
        # recovery_z_threshold * stddev of the baseline (more lenient than detection)
        cfg = settings.anomaly_detection
        recovery_z_threshold = max(1.0, cfg.z_score_threshold - cfg.recovery_window * 0.1)

        with self._lock:
            ids = [(k, i) for k, i in self._active.items() if k[0] == room and k[1] == sensor_id]

        z = abs(value - mean) / stddev
        for key, anomaly_id in ids:
            anomaly = db.get(AnomalyEvent, anomaly_id)
            if anomaly is None or anomaly.status == AnomalyStatus.RESOLVED:
                with self._lock:
                    self._active.pop(key, None)
                    self._last_anomaly_time.pop(key, None)
            elif z <= recovery_z_threshold:
                self._resolve_anomaly_obj(db, anomaly, actor="system")

    def _forget(self, anomaly: AnomalyEvent) -> None:
        key = (anomaly.room, anomaly.sensor_id, anomaly.anomaly_category.value)
        with self._lock:
            if self._active.get(key) == anomaly.id:
                self._active.pop(key, None)
                self._last_anomaly_time.pop(key, None)

    def _resolve_anomaly_obj(
        self,
        db: Session,
        anomaly: AnomalyEvent,
        actor: str | None = "system",
        at: datetime | None = None,
    ):
        """Resolve an anomaly event in-place and record the transition."""
        now = at or datetime.now(UTC)
        previous = anomaly.status
        anomaly.status = AnomalyStatus.RESOLVED
        anomaly.resolved_at = now
        anomaly.updated_at = datetime.now(UTC)
        db.add(anomaly)
        db.flush()
        track_transition(
            db, "anomaly", anomaly, previous, AnomalyStatus.RESOLVED, actor, now, "resolved"
        )
        self._forget(anomaly)
        logger.info(f"Anomaly resolved: {anomaly.id} ({anomaly.room}/{anomaly.sensor_id})")

    # ------------------------------------------------------------------ #
    # Lifecycle transitions                                              #
    # ------------------------------------------------------------------ #
    def acknowledge_anomaly(
        self, anomaly_id: int, actor: str | None = None, db: Session | None = None
    ) -> AnomalyEvent | None:
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True
        try:
            anomaly = db.query(AnomalyEvent).filter(AnomalyEvent.id == anomaly_id).first()
            if not anomaly:
                return None
            if anomaly.status == AnomalyStatus.RESOLVED:
                raise ValueError("Cannot acknowledge a resolved anomaly")
            if anomaly.status == AnomalyStatus.ACKNOWLEDGED:
                return anomaly  # idempotent: no new audit row for a no-op
            now = datetime.now(UTC)
            previous = anomaly.status
            anomaly.status = AnomalyStatus.ACKNOWLEDGED
            anomaly.acknowledged_at = now
            anomaly.acknowledged_by = actor
            anomaly.updated_at = now
            track_transition(
                db,
                "anomaly",
                anomaly,
                previous,
                AnomalyStatus.ACKNOWLEDGED,
                actor,
                now,
                "acknowledged",
            )
            db.commit()
            db.refresh(anomaly)
            return anomaly
        except Exception:
            db.rollback()
            raise
        finally:
            if own_session:
                db.close()

    def resolve_anomaly(
        self, anomaly_id: int, actor: str | None = None, db: Session | None = None
    ) -> AnomalyEvent | None:
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True
        try:
            anomaly = db.query(AnomalyEvent).filter(AnomalyEvent.id == anomaly_id).first()
            if not anomaly:
                return None
            if anomaly.status == AnomalyStatus.RESOLVED:
                raise ValueError("Anomaly is already resolved")
            self._resolve_anomaly_obj(db, anomaly, actor=actor)
            db.commit()
            db.refresh(anomaly)
            return anomaly
        except Exception:
            db.rollback()
            raise
        finally:
            if own_session:
                db.close()

    # ------------------------------------------------------------------ #
    # Queries                                                            #
    # ------------------------------------------------------------------ #
    def get_anomaly(self, anomaly_id: int, db: Session | None = None) -> AnomalyEvent | None:
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True
        try:
            return db.query(AnomalyEvent).filter(AnomalyEvent.id == anomaly_id).first()
        finally:
            if own_session:
                db.close()

    def get_anomalies(self, filters: dict, db: Session | None = None) -> list[AnomalyEvent]:
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True
        try:
            query = db.query(AnomalyEvent)
            if filters.get("room"):
                query = query.filter(AnomalyEvent.room == filters["room"])
            if filters.get("sensor_id"):
                query = query.filter(AnomalyEvent.sensor_id == filters["sensor_id"])
            if filters.get("anomaly_category"):
                query = query.filter(AnomalyEvent.anomaly_category == filters["anomaly_category"])
            if filters.get("severity"):
                query = query.filter(AnomalyEvent.severity == filters["severity"])
            if filters.get("status"):
                query = query.filter(AnomalyEvent.status == filters["status"])
            if filters.get("start"):
                query = query.filter(AnomalyEvent.detected_at >= filters["start"])
            if filters.get("end"):
                query = query.filter(AnomalyEvent.detected_at <= filters["end"])

            sort_by = filters.get("sort_by", "detected_at")
            sort_order = filters.get("sort_order", "desc")
            sort_col = getattr(AnomalyEvent, sort_by, AnomalyEvent.detected_at)
            if sort_order == "asc":
                query = query.order_by(sort_col.asc(), AnomalyEvent.id.asc())
            else:
                query = query.order_by(sort_col.desc(), AnomalyEvent.id.desc())

            limit = int(filters.get("limit", 50))
            offset = int(filters.get("offset", 0))
            query = query.limit(limit).offset(offset)
            return query.all()
        finally:
            if own_session:
                db.close()

    def get_anomaly_counts(self, db: Session | None = None) -> dict:
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True
        try:
            total = db.query(AnomalyEvent).count()

            by_severity_rows = (
                db.query(AnomalyEvent.severity, func.count(AnomalyEvent.id))
                .group_by(AnomalyEvent.severity)
                .all()
            )
            by_status_rows = (
                db.query(AnomalyEvent.status, func.count(AnomalyEvent.id))
                .group_by(AnomalyEvent.status)
                .all()
            )
            by_category_rows = (
                db.query(AnomalyEvent.anomaly_category, func.count(AnomalyEvent.id))
                .group_by(AnomalyEvent.anomaly_category)
                .all()
            )

            return {
                "total": total,
                "by_severity": [
                    {"severity": sev.value, "count": cnt} for sev, cnt in by_severity_rows
                ],
                "by_status": [{"status": st.value, "count": cnt} for st, cnt in by_status_rows],
                "by_category": [
                    {"category": cat.value, "count": cnt} for cat, cnt in by_category_rows
                ],
            }
        finally:
            if own_session:
                db.close()

    # ------------------------------------------------------------------ #
    # Message building                                                   #
    # ------------------------------------------------------------------ #
    def _build_anomaly_message(
        self,
        room: str,
        sensor_id: str,
        category: AnomalyCategory,
        severity: AnomalySeverity,
        value: float,
        baseline: float,
        z_score: float,
    ) -> tuple[str, str]:
        category_labels = {
            AnomalyCategory.Z_SCORE_SPIKE: "statistical spike",
            AnomalyCategory.Z_SCORE_DROP: "statistical drop",
            AnomalyCategory.SUSTAINED_DEVIATION: "sustained deviation",
        }
        label = category_labels.get(category, "anomaly")
        direction = "above" if value > baseline else "below"
        title = f"{severity.value.title()} {label} in {room}"
        description = (
            f"Sensor {sensor_id} in {room} reported {value}°C, which is {direction} "
            f"the statistical baseline of {baseline:.1f}°C (z-score: {z_score:.2f}). "
            f"This is a statistically unusual reading, not a threshold breach."
        )
        return title, description


anomaly_service = AnomalyService()
