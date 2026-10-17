import os
import yaml
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class SimulatorSensorConfig(BaseSettings):
    room: str
    sensor_id: str
    baseline: float = 22.0
    variation: float = 1.5
    min_temp: float = 18.0
    max_temp: float = 35.0


class SimulatorConfig(BaseSettings):
    enabled: bool = True
    interval_seconds: int = 5
    seed: int = 42
    sensors: list[SimulatorSensorConfig] = []


class RetentionConfig(BaseSettings):
    enabled: bool = True
    raw_telemetry_days: int = 30
    cleanup_interval_hours: int = 6
    batch_size: int = 1000
    dry_run: bool = False


class AggregationConfig(BaseSettings):
    max_bucket_interval_hours: int = 24
    default_bucket_interval_minutes: int = 15
    supported_intervals: list[str] = ["1m", "5m", "15m", "1h", "6h", "12h", "24h"]


class AlertThresholdConfig(BaseSettings):
    warning: float = 30.0
    critical: float = 35.0
    recovery: float = 28.0


class LowTemperatureConfig(BaseSettings):
    enabled: bool = False
    warning: float = 15.0
    critical: float = 10.0


class HysteresisConfig(BaseSettings):
    enabled: bool = True
    threshold_gap: float = 0.5


class AlertConfig(BaseSettings):
    enabled: bool = True
    evaluation_interval_seconds: int = 30
    stale_sensor_seconds: int = 120
    temperature: AlertThresholdConfig = AlertThresholdConfig()
    low_temperature: LowTemperatureConfig = LowTemperatureConfig()
    hysteresis: HysteresisConfig = HysteresisConfig()
    max_occurrence_count: int = 1000


class AnomalyDetectionConfig(BaseSettings):
    enabled: bool = True
    rolling_window_size: int = 20
    min_samples: int = 5
    z_score_threshold: float = 3.0
    spike_threshold: float = 5.0
    drop_threshold: float = 5.0
    sustained_deviation_threshold: float = 2.5
    cooldown_seconds: int = 300
    recovery_window: int = 10
    warm_up_seconds: int = 60


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mqtt_broker: str = "localhost"
    mqtt_port: int = 1883
    mqtt_topic: str = "building/+/temperature"
    mqtt_client_id: str = "smart-building-backend"

    database_url: str = "sqlite:///./smart_building.db"

    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_debug: bool = True
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    simulation_rooms: list[str] = ["room101", "room102", "room103", "room104"]
    temp_min: float = 20.0
    temp_max: float = 40.0
    threshold_normal: float = 30.0
    threshold_high: float = 35.0
    history_limit: int = 100
    activity_log_limit: int = 50

    simulator: SimulatorConfig = SimulatorConfig()
    retention: RetentionConfig = RetentionConfig()
    aggregation: AggregationConfig = AggregationConfig()
    alerts: AlertConfig = AlertConfig()
    anomaly_detection: AnomalyDetectionConfig = AnomalyDetectionConfig()

    @classmethod
    def from_yaml(cls, path: str = "config.yaml") -> "Settings":
        # Try to find config.yaml relative to the project root
        config_path = Path(path)
        if not config_path.is_absolute():
            # Try to find config.yaml in parent directories
            current = Path(__file__).parent.parent.parent.parent
            while current != current.parent:
                candidate = current / path
                if candidate.exists():
                    config_path = candidate
                    break
                current = current.parent

        if config_path.exists():
            with open(config_path) as f:
                data = yaml.safe_load(f)
            if data:
                simulator_data = data.get("simulator", {})
                sensors_data = simulator_data.get("sensors", [])
                sensors = [SimulatorSensorConfig(**s) for s in sensors_data]
                return cls(
                    mqtt_broker=os.getenv(
                        "MQTT_BROKER", data.get("mqtt", {}).get("broker", "localhost")
                    ),
                    mqtt_port=int(os.getenv("MQTT_PORT", data.get("mqtt", {}).get("port", 1883))),
                    mqtt_topic=data.get("mqtt", {}).get("topic", "building/+/temperature"),
                    mqtt_client_id=data.get("mqtt", {}).get("client_id", "smart-building-backend"),
                    database_url=data.get("database", {}).get(
                        "url", "sqlite:///./smart_building.db"
                    ),
                    app_host=data.get("app", {}).get("host", "0.0.0.0"),
                    app_port=data.get("app", {}).get("port", 8000),
                    app_debug=data.get("app", {}).get("debug", True),
                    cors_origins=data.get("app", {}).get(
                        "cors_origins", ["http://localhost:5173", "http://127.0.0.1:5173"]
                    ),
                    simulation_rooms=data.get("simulation", {}).get(
                        "rooms", ["room101", "room102", "room103", "room104"]
                    ),
                    temp_min=data.get("simulation", {})
                    .get("temperature_bounds", {})
                    .get("min", 20.0),
                    temp_max=data.get("simulation", {})
                    .get("temperature_bounds", {})
                    .get("max", 40.0),
                    threshold_normal=data.get("simulation", {})
                    .get("thresholds", {})
                    .get("normal_max", 30.0),
                    threshold_high=data.get("simulation", {})
                    .get("thresholds", {})
                    .get("high_max", 35.0),
                    history_limit=data.get("simulation", {}).get("history_limit", 100),
                    activity_log_limit=data.get("simulation", {}).get("activity_log_limit", 50),
                    simulator=SimulatorConfig(
                        enabled=simulator_data.get("enabled", True),
                        interval_seconds=simulator_data.get("interval_seconds", 5),
                        seed=simulator_data.get("seed", 42),
                        sensors=sensors,
                    ),
                    retention=RetentionConfig(
                        enabled=data.get("retention", {}).get("enabled", True),
                        raw_telemetry_days=data.get("retention", {}).get("raw_telemetry_days", 30),
                        cleanup_interval_hours=data.get("retention", {}).get(
                            "cleanup_interval_hours", 6
                        ),
                        batch_size=data.get("retention", {}).get("batch_size", 1000),
                        dry_run=data.get("retention", {}).get("dry_run", False),
                    ),
                    aggregation=AggregationConfig(
                        max_bucket_interval_hours=data.get("aggregation", {}).get(
                            "max_bucket_interval_hours", 24
                        ),
                        default_bucket_interval_minutes=data.get("aggregation", {}).get(
                            "default_bucket_interval_minutes", 15
                        ),
                        supported_intervals=data.get("aggregation", {}).get(
                            "supported_intervals", ["1m", "5m", "15m", "1h", "6h", "12h", "24h"]
                        ),
                    ),
                    alerts=AlertConfig(
                        enabled=data.get("alerts", {}).get("enabled", True),
                        evaluation_interval_seconds=data.get("alerts", {}).get(
                            "evaluation_interval_seconds", 30
                        ),
                        stale_sensor_seconds=data.get("alerts", {}).get(
                            "stale_sensor_seconds", 120
                        ),
                        temperature=AlertThresholdConfig(
                            warning=data.get("alerts", {})
                            .get("thresholds", {})
                            .get("temperature", {})
                            .get("warning", 30.0),
                            critical=data.get("alerts", {})
                            .get("thresholds", {})
                            .get("temperature", {})
                            .get("critical", 35.0),
                            recovery=data.get("alerts", {})
                            .get("thresholds", {})
                            .get("temperature", {})
                            .get("recovery", 28.0),
                        ),
                        low_temperature=LowTemperatureConfig(
                            enabled=data.get("alerts", {})
                            .get("thresholds", {})
                            .get("low_temperature", {})
                            .get("enabled", False),
                            warning=data.get("alerts", {})
                            .get("thresholds", {})
                            .get("low_temperature", {})
                            .get("warning", 15.0),
                            critical=data.get("alerts", {})
                            .get("thresholds", {})
                            .get("low_temperature", {})
                            .get("critical", 10.0),
                        ),
                        hysteresis=HysteresisConfig(
                            enabled=data.get("alerts", {})
                            .get("hysteresis", {})
                            .get("enabled", True),
                            threshold_gap=data.get("alerts", {})
                            .get("hysteresis", {})
                            .get("threshold_gap", 0.5),
                        ),
                        max_occurrence_count=data.get("alerts", {}).get(
                            "max_occurrence_count", 1000
                        ),
                    ),
                    anomaly_detection=AnomalyDetectionConfig(
                        enabled=data.get("anomaly_detection", {}).get("enabled", True),
                        rolling_window_size=data.get("anomaly_detection", {}).get(
                            "rolling_window_size", 20
                        ),
                        min_samples=data.get("anomaly_detection", {}).get("min_samples", 5),
                        z_score_threshold=data.get("anomaly_detection", {}).get(
                            "z_score_threshold", 3.0
                        ),
                        spike_threshold=data.get("anomaly_detection", {}).get(
                            "spike_threshold", 5.0
                        ),
                        drop_threshold=data.get("anomaly_detection", {}).get("drop_threshold", 5.0),
                        sustained_deviation_threshold=data.get("anomaly_detection", {}).get(
                            "sustained_deviation_threshold", 2.5
                        ),
                        cooldown_seconds=data.get("anomaly_detection", {}).get(
                            "cooldown_seconds", 300
                        ),
                        recovery_window=data.get("anomaly_detection", {}).get(
                            "recovery_window", 10
                        ),
                        warm_up_seconds=data.get("anomaly_detection", {}).get(
                            "warm_up_seconds", 60
                        ),
                    ),
                )
        return cls(
            mqtt_broker=os.getenv("MQTT_BROKER", "localhost"),
            mqtt_port=int(os.getenv("MQTT_PORT", "1883")),
        )


settings = Settings.from_yaml()
