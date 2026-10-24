import json
import logging
import paho.mqtt.client as mqtt
import random
import threading
import time
from app.core.config import settings
from app.core.database import SessionLocal
from app.models.topology import Building
from app.services import sim_model
from app.services.topology_service import SimSensor, sim_sensors
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

logger = logging.getLogger(__name__)

INJECTION_KINDS = ("spike", "drift", "offline")
DEFAULT_MAGNITUDE = {"temperature": 12.0, "power_kw": 15.0}
DRIFT_RATE_PER_TICK = 0.1  # fraction of `magnitude` added per publish tick, capped at magnitude
MAX_INJECTION_SECONDS = 3600


@dataclass
class Injection:
    kind: str
    started: datetime
    until: datetime
    magnitude: float
    ticks: int = 0


class SensorSimulator:
    """Publishes seeded readings for every enabled simulated sensor in the topology.

    transport "mqtt" (default) publishes through the broker like a real device would.
    transport "direct" hands the same payload to the ingestion path in-process, so the
    whole stack runs without a broker (local development, CI, the E2E golden loop).
    """

    def __init__(self):
        self.client: mqtt.Client | None = None
        self.running = False
        self.thread: threading.Thread | None = None
        self.sensors: list[SimSensor] = []
        self.interval = settings.simulator.interval_seconds
        self.seed = settings.simulator.seed
        self.transport = settings.simulator.transport
        self.random = random.Random(self.seed)
        self.temperatures: dict[str, float] = {}  # latest *reported* value per sensor
        self._walk: dict[str, float] = {}  # underlying signal, unaffected by injections
        self.timezone = "UTC"
        self.topic_prefix = "building"
        self.injections: dict[str, Injection] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # Lifecycle                                                          #
    # ------------------------------------------------------------------ #
    def load_sensors(self) -> None:
        db = SessionLocal()
        try:
            self.sensors = sim_sensors(db)
            building = db.query(Building).order_by(Building.id).first()
            self.timezone = building.timezone if building else "UTC"
        finally:
            db.close()
        self.temperatures = {s.sensor_id: s.baseline for s in self.sensors}
        self._walk = dict(self.temperatures)

    def start(self):
        if self.running:
            logger.warning("Simulator already running")
            return

        if not settings.simulator.enabled:
            logger.info("Simulator disabled in config")
            return

        self.load_sensors()
        self.random = random.Random(self.seed)

        if self.transport == "mqtt":
            self.client = mqtt.Client(
                mqtt.CallbackAPIVersion.VERSION2, client_id=f"{settings.mqtt_client_id}-simulator"
            )
            self.client.on_connect = self._on_connect
            self.client.on_disconnect = self._on_disconnect
            try:
                self.client.connect(settings.mqtt_broker, settings.mqtt_port, 60)
                self.client.loop_start()
                logger.info(
                    f"Simulator connecting to MQTT broker at {settings.mqtt_broker}:{settings.mqtt_port}"
                )
            except Exception as e:
                logger.warning(
                    f"Simulator failed to connect to MQTT broker (will retry in background): {e}"
                )

        self.running = True
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()
        logger.info(
            f"Sensor simulator started: {len(self.sensors)} sensors, interval={self.interval}s, "
            f"seed={self.seed}, transport={self.transport}"
        )

    def stop(self):
        if not self.running:
            return

        self.running = False
        if self.thread:
            self.thread.join(timeout=5)
            self.thread = None

        if self.client:
            self.client.loop_stop()
            self.client.disconnect()
            self.client = None

        logger.info("Sensor simulator stopped")

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if not reason_code.is_failure:
            logger.info("Simulator connected to MQTT broker")
        else:
            logger.error(f"Simulator failed to connect to MQTT broker: {reason_code}")

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        logger.warning(f"Simulator disconnected from MQTT broker: {reason_code}")

    # ------------------------------------------------------------------ #
    # Scenario injection (demo / E2E)                                    #
    # ------------------------------------------------------------------ #
    def inject(
        self,
        sensor_id: str,
        kind: str,
        duration_seconds: int,
        magnitude: float | None = None,
    ) -> dict:
        """Start a live scenario on a sensor. Injected readings are tagged source=scenario.

        spike:   every reading is offset by `magnitude` for the duration
        drift:   offset ramps up each tick until it reaches `magnitude`
        offline: the sensor stops publishing (exercises stale detection)
        """
        if kind not in INJECTION_KINDS:
            raise ValueError(f"kind must be one of {INJECTION_KINDS}")
        if not 1 <= duration_seconds <= MAX_INJECTION_SECONDS:
            raise ValueError(f"duration_seconds must be between 1 and {MAX_INJECTION_SECONDS}")
        sensor = next((s for s in self.sensors if s.sensor_id == sensor_id), None)
        if sensor is None:
            raise LookupError(f"Unknown or non-simulated sensor: {sensor_id}")
        if not self.running:
            raise RuntimeError("Simulator is not running")

        mag = magnitude if magnitude is not None else DEFAULT_MAGNITUDE.get(sensor.type, 10.0)
        now = datetime.now(UTC)
        injection = Injection(kind, now, now + timedelta(seconds=duration_seconds), mag)
        with self._lock:
            self.injections[sensor_id] = injection
        logger.warning(
            f"Scenario injected: {kind} on {sensor_id} for {duration_seconds}s (mag={mag})"
        )
        return {
            "sensor_id": sensor_id,
            "kind": kind,
            "magnitude": mag,
            "started": now.isoformat(),
            "until": injection.until.isoformat(),
        }

    def active_injections(self) -> list[dict]:
        now = datetime.now(UTC)
        with self._lock:
            return [
                {
                    "sensor_id": sid,
                    "kind": inj.kind,
                    "magnitude": inj.magnitude,
                    "until": inj.until.isoformat(),
                }
                for sid, inj in self.injections.items()
                if inj.until > now
            ]

    # ------------------------------------------------------------------ #
    # Publishing                                                         #
    # ------------------------------------------------------------------ #
    def _run_loop(self):
        while self.running:
            start_time = time.time()
            try:
                self._publish_readings()
            except Exception as e:
                logger.error(f"Error in simulator loop: {e}")

            elapsed = time.time() - start_time
            sleep_time = max(0, self.interval - elapsed)
            while sleep_time > 0 and self.running:
                chunk = min(0.5, sleep_time)
                time.sleep(chunk)
                sleep_time -= chunk

    def _next_value(self, sensor: SimSensor, now: datetime) -> float:
        if sensor.type in sim_model.POWER_TYPES:
            hour = sim_model.local_hour(now, self.timezone)
            return sim_model.next_power(
                sensor.baseline,
                sensor.variation,
                sensor.min_value,
                sensor.max_value,
                hour,
                self.random,
            )
        current = self._walk.get(sensor.sensor_id, sensor.baseline)
        return sim_model.next_temperature(
            current,
            sensor.baseline,
            sensor.variation,
            sensor.min_value,
            sensor.max_value,
            self.random,
        )

    def _injection_for(self, sensor_id: str, now: datetime) -> Injection | None:
        with self._lock:
            inj = self.injections.get(sensor_id)
            if inj is None:
                return None
            if inj.until <= now:
                del self.injections[sensor_id]
                return None
            return inj

    def _publish_readings(self):
        if self.transport == "mqtt" and not self.client:
            logger.warning("MQTT client not available, skipping publish")
            return

        now = datetime.now(UTC)
        timestamp = now.isoformat()
        compact = timestamp.replace(":", "").replace("-", "").replace(".", "").replace("+", "")

        for sensor in self.sensors:
            try:
                # The walk always advances, so the underlying signal is the same with or
                # without an injection; an injection only changes what is reported.
                value = self._next_value(sensor, now)
                self._walk[sensor.sensor_id] = value

                source = "simulated"
                inj = self._injection_for(sensor.sensor_id, now)
                if inj is not None:
                    if inj.kind == "offline":
                        continue
                    source = "scenario"
                    inj.ticks += 1
                    if inj.kind == "spike":
                        value = round(value + inj.magnitude, 2)
                    else:  # drift
                        ramp = min(1.0, DRIFT_RATE_PER_TICK * inj.ticks)
                        value = round(value + inj.magnitude * ramp, 2)
                self.temperatures[sensor.sensor_id] = value

                payload = {
                    "sensor_id": sensor.sensor_id,
                    "room": sensor.location,
                    "measurement": sensor.type,
                    "value": value,
                    "unit": sensor.unit,
                    "source": source,
                    "event_timestamp": timestamp,
                    "idempotency_key": f"{sensor.sensor_id}-{compact}",
                }

                if self.transport == "direct":
                    from app.services.mqtt_service import mqtt_service

                    mqtt_service.ingest(sensor.location, payload)
                    continue

                topic = f"{self.topic_prefix}/{sensor.location}/{sensor.type}"
                result = self.client.publish(topic, json.dumps(payload), qos=1)
                if result.rc != mqtt.MQTT_ERR_SUCCESS:
                    logger.error(f"Failed to publish to {topic}: {result.rc}")
                else:
                    logger.debug(f"Published {sensor.sensor_id}: {value} to {topic}")

            except Exception as e:
                logger.error(f"Error publishing reading for {sensor.sensor_id}: {e}")


sensor_simulator = SensorSimulator()
