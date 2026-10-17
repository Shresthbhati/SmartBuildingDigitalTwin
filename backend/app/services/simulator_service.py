import json
import logging
import paho.mqtt.client as mqtt
import random
import threading
import time
from app.core.config import settings
from datetime import UTC, datetime

logger = logging.getLogger(__name__)


class SensorSimulator:
    def __init__(self):
        self.client: mqtt.Client | None = None
        self.running = False
        self.thread: threading.Thread | None = None
        self.sensors = settings.simulator.sensors
        self.interval = settings.simulator.interval_seconds
        self.seed = settings.simulator.seed
        self.random = random.Random(self.seed)
        self.temperatures = {s.sensor_id: s.baseline for s in self.sensors}
        self.topic_prefix = "building"

    def start(self):
        if self.running:
            logger.warning("Simulator already running")
            return

        if not settings.simulator.enabled:
            logger.info("Simulator disabled in config")
            return

        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id=f"{settings.mqtt_client_id}-simulator"
        )
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_publish = self._on_publish

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
            f"Sensor simulator started with {len(self.sensors)} sensors, interval={self.interval}s, seed={self.seed}"
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

    def _on_publish(self, client, userdata, mid, reason_code=None, properties=None):
        pass  # Optionally log successful publishes

    def _run_loop(self):
        while self.running:
            start_time = time.time()
            try:
                self._publish_readings()
            except Exception as e:
                logger.error(f"Error in simulator loop: {e}")

            elapsed = time.time() - start_time
            sleep_time = max(0, self.interval - elapsed)
            if sleep_time > 0:
                time.sleep(sleep_time)

    def _publish_readings(self):
        if not self.client:
            logger.warning("MQTT client not available, skipping publish")
            return

        timestamp = datetime.now(UTC).isoformat()

        for sensor in self.sensors:
            try:
                current = self.temperatures.get(sensor.sensor_id, sensor.baseline)
                variation = self.random.uniform(-sensor.variation, sensor.variation)
                new_temp = current + variation

                new_temp = max(sensor.min_temp, min(sensor.max_temp, new_temp))
                new_temp = round(new_temp, 1)

                self.temperatures[sensor.sensor_id] = new_temp

                payload = {
                    "sensor_id": sensor.sensor_id,
                    "room": sensor.room,
                    "measurement": "temperature",
                    "value": new_temp,
                    "unit": "celsius",
                    "source": "simulated",
                    "event_timestamp": timestamp,
                    "idempotency_key": f"{sensor.sensor_id}-{timestamp.replace(':', '').replace('-', '').replace('.', '')}",
                }

                topic = f"{self.topic_prefix}/{sensor.room}/temperature"
                result = self.client.publish(topic, json.dumps(payload), qos=1)

                if result.rc != mqtt.MQTT_ERR_SUCCESS:
                    logger.error(f"Failed to publish to {topic}: {result.rc}")
                else:
                    logger.debug(f"Published {sensor.sensor_id}: {new_temp}°C to {topic}")

            except Exception as e:
                logger.error(f"Error publishing reading for {sensor.sensor_id}: {e}")


sensor_simulator = SensorSimulator()
