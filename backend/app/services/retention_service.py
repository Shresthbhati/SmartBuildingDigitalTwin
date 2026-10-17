import logging
import threading
import time
from app.core.config import settings
from app.core.database import SessionLocal
from app.models.sensor import SensorReading
from datetime import UTC, datetime, timedelta

logger = logging.getLogger(__name__)


class RetentionService:
    def __init__(self):
        self.running = False
        self.thread: threading.Thread | None = None
        self.last_run: datetime | None = None
        self.last_deleted_count: int = 0
        self.last_error: str | None = None
        self._lock = threading.Lock()

    def start(self):
        if self.running:
            logger.warning("Retention service already running")
            return

        if not settings.retention.enabled:
            logger.info("Retention service disabled in config")
            return

        self.running = True
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()
        logger.info(
            f"Retention service started: raw_telemetry_days={settings.retention.raw_telemetry_days}, "
            f"cleanup_interval_hours={settings.retention.cleanup_interval_hours}, "
            f"batch_size={settings.retention.batch_size}, dry_run={settings.retention.dry_run}"
        )

    def stop(self):
        if not self.running:
            return

        self.running = False
        if self.thread:
            self.thread.join(timeout=10)
            self.thread = None

        logger.info("Retention service stopped")

    def _run_loop(self):
        while self.running:
            start_time = time.time()
            try:
                self.run_cleanup()
            except Exception as e:
                logger.error(f"Error in retention loop: {e}")
                with self._lock:
                    self.last_error = str(e)

            elapsed = time.time() - start_time
            sleep_seconds = max(0, settings.retention.cleanup_interval_hours * 3600 - elapsed)
            # Sleep in small increments to allow for clean shutdown
            while sleep_seconds > 0 and self.running:
                sleep_chunk = min(60, sleep_seconds)
                time.sleep(sleep_chunk)
                sleep_seconds -= sleep_chunk

    def run_cleanup(self) -> int:
        """Run a single cleanup cycle. Returns number of deleted records."""
        if settings.retention.dry_run:
            return self._dry_run()

        cutoff = datetime.now(UTC) - timedelta(days=settings.retention.raw_telemetry_days)
        batch_size = settings.retention.batch_size
        total_deleted = 0

        db = SessionLocal()
        try:
            while True:
                # Find IDs to delete in batches
                readings_to_delete = (
                    db.query(SensorReading.id)
                    .filter(SensorReading.event_timestamp < cutoff)
                    .order_by(SensorReading.event_timestamp)
                    .limit(batch_size)
                    .all()
                )

                if not readings_to_delete:
                    break

                ids = [r.id for r in readings_to_delete]

                # Delete in batch
                deleted = (
                    db.query(SensorReading)
                    .filter(SensorReading.id.in_(ids))
                    .delete(synchronize_session=False)
                )

                db.commit()
                total_deleted += deleted

                logger.info(
                    f"Retention: deleted {deleted} records (batch), total so far: {total_deleted}"
                )

                if deleted < batch_size:
                    break

        except Exception as e:
            db.rollback()
            logger.error(f"Retention cleanup error: {e}")
            with self._lock:
                self.last_error = str(e)
            raise
        finally:
            db.close()

        with self._lock:
            self.last_run = datetime.now(UTC)
            self.last_deleted_count = total_deleted
            self.last_error = None

        logger.info(f"Retention cleanup completed: deleted {total_deleted} records")
        return total_deleted

    def _dry_run(self) -> int:
        """Count records that would be deleted without actually deleting."""
        cutoff = datetime.now(UTC) - timedelta(days=settings.retention.raw_telemetry_days)

        db = SessionLocal()
        try:
            count = db.query(SensorReading).filter(SensorReading.event_timestamp < cutoff).count()
            logger.info(f"Retention dry-run: {count} records eligible for deletion")
            return count
        finally:
            db.close()


retention_service = RetentionService()
