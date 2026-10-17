import json
import logging
import math
import threading
import time
from app.core.config import settings
from app.core.database import SessionLocal
from app.models.anomaly import (
    AnomalyCategory,
    AnomalyEvent,
    AnomalySeverity,
    AnomalyStatus,
)
from app.models.sensor import SensorReading
from datetime import UTC, datetime, timedelta
from sqlalchemy import desc, func
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


class RollingWindowCache:
    """Thread-safe rolling window of recent readings per (room, sensor_id).

    Maintains a bounded deque of (timestamp, value) tuples. On restart,
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
        # Get distinct (room, sensor_id) pairs
        pairs = db.query(SensorReading.room, SensorReading.sensor_id).distinct().all()
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
            window = [(r.event_timestamp, r.value) for r in reversed(readings)]
            key = (room, sensor_id)
            with self._lock:
                self._windows[key] = window
                if window:
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
    - Sustained deviation detection (multiple consecutive abnormal readings)
    - Cooldown/deduplication to avoid duplicate events during sustained conditions
    - Recovery detection when readings return to acceptable range
    - Warm-up period to avoid false positives during sensor initialization
    """

    def __init__(self):
        self.running = False
        self.thread: threading.Thread | None = None
        self.last_run: datetime | None = None
        self.last_error: str | None = None
        self._lock = threading.Lock()

        # Rolling baseline cache: (room, sensor_id) -> list of (timestamp, value)
        self._cache = RollingWindowCache(window_size=settings.anomaly_detection.rolling_window_size)

        # Active anomaly tracking for deduplication:
        # Key: (room, sensor_id, anomaly_category) -> AnomalyEvent
        self._active_anomalies: dict[tuple[str, str, str], AnomalyEvent] = {}

        # Cooldown tracking: last anomaly creation time per key
        self._last_anomaly_time: dict[tuple[str, str, str], datetime] = {}

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
        # Rebuild rolling baseline from DB on restart
        db = SessionLocal()
        try:
            self._cache.load_from_db(db)
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

    def _run_loop(self):
        while self.running:
            start_time = time.time()
            try:
                self._evaluate_recovery()
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
        db: Session | None = None,
    ) -> None:
        """Evaluate a single telemetry reading for anomalies.

        Idempotent and safe: failures do not propagate to the caller.
        Updates the rolling baseline and creates/resolves anomaly events.
        """
        own_session = False
        if db is None:
            db = SessionLocal()
            own_session = True

        if event_timestamp is None:
            event_timestamp = datetime.now(UTC)

        try:
            # 1. Skip invalid / non-finite readings - never treat missing data as zero
            if value is None or not math.isfinite(value):
                return

            # 2. Update rolling baseline cache
            self._cache.add(room, sensor_id, event_timestamp, value)

            # 3. Check warm-up: need min_samples and warm_up_seconds elapsed
            if not self._is_warmed_up(room, sensor_id, event_timestamp):
                return

            # 4. Get rolling baseline statistics
            window = self._cache.get_window(room, sensor_id)
            baseline = self._compute_baseline(window)
            if baseline is None:
                return  # Not enough data yet

            mean, stddev, count = baseline

            # 5. Detect anomalies
            anomaly = self._detect_anomaly(
                room, sensor_id, value, mean, stddev, count, event_timestamp, unit
            )

            if anomaly:
                self._upsert_anomaly(db, anomaly)
                db.commit()
            else:
                # No anomaly detected - check if any active anomaly should recover
                self._check_recovery(db, room, sensor_id, value, mean, stddev, event_timestamp)
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
                active_keys = list(self._active_anomalies.keys())

            for room, sensor_id, _category in active_keys:
                # Get latest reading for this sensor
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

                window = self._cache.get_window(room, sensor_id)
                baseline = self._compute_baseline(window)
                if baseline is None:
                    continue

                mean, stddev, count = baseline
                value = latest.value
                event_ts = latest.event_timestamp

                self._check_recovery(db, room, sensor_id, value, mean, stddev, event_ts)

            db.commit()
        except Exception as e:
            db.rollback()
            logger.error(f"Error in anomaly recovery evaluation: {e}")
        finally:
            db.close()

    # ------------------------------------------------------------------ #
    # Internal detection helpers                                         #
    # ------------------------------------------------------------------ #
    def _is_warmed_up(self, room: str, sensor_id: str, now: datetime) -> bool:
        """Check if enough samples and warm-up time have elapsed."""
        window = self._cache.get_window(room, sensor_id)
        if len(window) < settings.anomaly_detection.min_samples:
            return False

        first_seen = self._cache.get_first_seen(room, sensor_id)
        if first_seen is None:
            return False

        warm_up = timedelta(seconds=settings.anomaly_detection.warm_up_seconds)
        return now - first_seen >= warm_up

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

        if count < 2:
            return mean, 0.0, count

        variance = sum((v - mean) ** 2 for v in values) / (count - 1)
        stddev = math.sqrt(variance)

        # Avoid division by zero for constant readings
        if stddev < 1e-9:
            stddev = 1e-9

        return mean, stddev, count

    def _detect_anomaly(
        self,
        room: str,
        sensor_id: str,
        value: float,
        mean: float,
        stddev: float,
        count: int,
        event_timestamp: datetime,
        unit: str,
    ) -> dict | None:
        """Detect if a reading is anomalous based on z-score and thresholds.

        Returns an anomaly dict or None if no anomaly.
        """
        z_threshold = settings.anomaly_detection.z_score_threshold
        spike_threshold = settings.anomaly_detection.spike_threshold
        drop_threshold = settings.anomaly_detection.drop_threshold

        # Compute z-score
        z_score = abs(value - mean) / stddev if stddev > 0 else 0.0

        # Determine anomaly category and severity
        anomaly_category = None
        severity = None
        deviation_score = z_score

        if z_score > spike_threshold:
            # Strong spike
            anomaly_category = AnomalyCategory.Z_SCORE_SPIKE
            severity = (
                AnomalySeverity.CRITICAL
                if z_score > spike_threshold * 1.5
                else AnomalySeverity.WARNING
            )
            deviation_score = z_score
        elif z_score > drop_threshold:
            # Strong drop (value significantly below baseline)
            anomaly_category = AnomalyCategory.Z_SCORE_DROP
            severity = (
                AnomalySeverity.CRITICAL
                if z_score > drop_threshold * 1.5
                else AnomalySeverity.WARNING
            )
            deviation_score = z_score
        elif z_score > z_threshold:
            # Moderate deviation - check if sustained
            anomaly_category = AnomalyCategory.SUSTAINED_DEVIATION
            severity = AnomalySeverity.WARNING
            deviation_score = z_score
        else:
            return None  # Within normal bounds

        # Determine cooldown key
        cooldown_key = (room, sensor_id, anomaly_category.value)
        cooldown = timedelta(seconds=settings.anomaly_detection.cooldown_seconds)

        # Check if we already have an active anomaly of this type for this sensor
        active = self._active_anomalies.get(cooldown_key)
        if active:
            # Update existing anomaly - don't create duplicate
            now = datetime.now(UTC)
            last_time = self._last_anomaly_time.get(cooldown_key)
            if last_time and now - last_time < cooldown:
                # Still within cooldown - just update occurrence metadata
                active.last_observed_at = event_timestamp
                active.observed_value = value
                active.deviation_score = deviation_score
                active.occurrence_count = min(
                    active.occurrence_count + 1, settings.alerts.max_occurrence_count
                )
                active.updated_at = now
                return {
                    "action": "update_existing",
                    "anomaly": active,
                }
            # Cooldown expired - treat as new occurrence but resolve old first
            self._resolve_anomaly_obj(db=None, anomaly=active)  # Will be committed by caller
            # Fall through to create new

        # Create new anomaly event
        title, description = self._build_anomaly_message(
            room, sensor_id, anomaly_category, severity, value, mean, z_score
        )

        metadata = {
            "detection_method": "z_score",
            "z_score": round(z_score, 4),
            "rolling_mean": round(mean, 4),
            "rolling_stddev": round(stddev, 4),
            "sample_count": count,
            "threshold_used": spike_threshold
            if anomaly_category == AnomalyCategory.Z_SCORE_SPIKE
            else z_threshold,
            "unit": unit,
        }

        return {
            "action": "create_new",
            "anomaly": {
                "room": room,
                "sensor_id": sensor_id,
                "anomaly_category": anomaly_category,
                "severity": severity,
                "title": title,
                "description": description,
                "status": AnomalyStatus.OPEN,
                "detected_at": event_timestamp,
                "last_observed_at": event_timestamp,
                "observed_value": value,
                "expected_baseline": mean,
                "deviation_score": deviation_score,
                "occurrence_count": 1,
                "metadata_json": json.dumps(metadata),
            },
        }

    def _check_recovery(
        self,
        db: Session,
        room: str,
        sensor_id: str,
        value: float,
        mean: float,
        stddev: float,
        event_timestamp: datetime,
    ):
        """Check if any active anomalies for this sensor should be resolved
        because the reading has returned to acceptable range."""
        recovery_window = settings.anomaly_detection.recovery_window
        z_threshold = settings.anomaly_detection.z_score_threshold

        # An anomaly is considered recovered when the reading is within
        # recovery_window * stddev of the baseline (more lenient than detection)
        recovery_z_threshold = max(1.0, z_threshold - recovery_window * 0.1)

        with self._lock:
            active_for_sensor = [
                (k, a)
                for k, a in self._active_anomalies.items()
                if k[0] == room and k[1] == sensor_id
            ]

        for _key, anomaly in active_for_sensor:
            z_score = abs(value - mean) / stddev if stddev > 0 else 0.0
            if z_score <= recovery_z_threshold:
                self._resolve_anomaly_obj(db, anomaly)

    def _upsert_anomaly(self, db: Session, result: dict):
        """Insert or update an anomaly event in the database."""
        action = result["action"]
        anomaly_data = result["anomaly"]

        if action == "update_existing":
            anomaly = anomaly_data
            db.add(anomaly)
            db.flush()
            return anomaly

        # Create new
        anomaly = AnomalyEvent(**anomaly_data)
        db.add(anomaly)
        db.flush()

        # Track in memory for deduplication
        cooldown_key = (anomaly.room, anomaly.sensor_id, anomaly.anomaly_category.value)
        with self._lock:
            self._active_anomalies[cooldown_key] = anomaly
            self._last_anomaly_time[cooldown_key] = datetime.now(UTC)

        logger.info(
            f"Anomaly created: {anomaly.room}/{anomaly.sensor_id} "
            f"{anomaly.anomaly_category.value} {anomaly.severity.value} "
            f"(z={anomaly.deviation_score:.2f})"
        )
        return anomaly

    def _resolve_anomaly_obj(self, db: Session, anomaly: AnomalyEvent):
        """Resolve an anomaly event in-place."""
        anomaly.status = AnomalyStatus.RESOLVED
        anomaly.resolved_at = datetime.now(UTC)
        anomaly.updated_at = datetime.now(UTC)
        db.add(anomaly)
        db.flush()

        cooldown_key = (anomaly.room, anomaly.sensor_id, anomaly.anomaly_category.value)
        with self._lock:
            self._active_anomalies.pop(cooldown_key, None)
            self._last_anomaly_time.pop(cooldown_key, None)

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
            anomaly.status = AnomalyStatus.ACKNOWLEDGED
            anomaly.acknowledged_at = datetime.now(UTC)
            anomaly.acknowledged_by = actor
            anomaly.updated_at = datetime.now(UTC)
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
            anomaly.status = AnomalyStatus.RESOLVED
            anomaly.resolved_at = datetime.now(UTC)
            anomaly.updated_at = datetime.now(UTC)
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
                query = query.order_by(sort_col.asc())
            else:
                query = query.order_by(sort_col.desc())

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
