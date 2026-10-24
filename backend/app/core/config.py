import os
import yaml
from pathlib import Path
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


# --------------------------------------------------------------------- #
# Topology (canonical building description, seeded into the DB)         #
# --------------------------------------------------------------------- #
class TopologySensorConfig(BaseModel):
    sensor_id: str
    type: str = "temperature"
    unit: str = "celsius"
    source: str = "simulated"
    enabled: bool = True
    # Simulation parameters (only meaningful for source == "simulated")
    baseline: float = 22.0
    variation: float = 1.5
    min_value: float = 18.0
    max_value: float = 35.0


class TopologyRoomConfig(BaseModel):
    code: str
    name: str
    x: float
    z: float
    width: float = 5.0
    depth: float = 5.0
    sensors: list[TopologySensorConfig] = Field(default_factory=list)


class TopologyAssetConfig(BaseModel):
    code: str
    kind: str
    name: str
    x: float
    z: float
    room: str | None = None  # room code, if the asset lives inside a room
    sensors: list[TopologySensorConfig] = Field(default_factory=list)


class TopologyFloorConfig(BaseModel):
    level: int
    name: str
    elevation_m: float = 0.0
    height_m: float = 4.0
    rooms: list[TopologyRoomConfig] = Field(default_factory=list)
    assets: list[TopologyAssetConfig] = Field(default_factory=list)


class TopologyBuildingConfig(BaseModel):
    code: str = "hq"
    name: str = "Smart Building"
    timezone: str = "UTC"


class TopologyConfig(BaseModel):
    building: TopologyBuildingConfig = TopologyBuildingConfig()
    floors: list[TopologyFloorConfig] = Field(default_factory=list)

    def room_codes(self) -> list[str]:
        return [r.code for f in self.floors for r in f.rooms]


# --------------------------------------------------------------------- #
# Feature configs                                                       #
# --------------------------------------------------------------------- #
class SimulatorConfig(BaseModel):
    enabled: bool = True
    interval_seconds: int = 5
    seed: int = 42
    # "mqtt": publish through the broker. "direct": ingest in-process (no broker needed).
    transport: str = "mqtt"


class RetentionConfig(BaseModel):
    enabled: bool = True
    raw_telemetry_days: int = 30
    cleanup_interval_hours: int = 6
    batch_size: int = 1000
    dry_run: bool = False


class AggregationConfig(BaseModel):
    max_bucket_interval_hours: int = 24
    default_bucket_interval_minutes: int = 15
    supported_intervals: list[str] = ["1m", "5m", "15m", "1h", "6h", "12h", "24h"]


class AlertThresholdConfig(BaseModel):
    warning: float = 30.0
    critical: float = 35.0
    recovery: float = 28.0


class LowTemperatureConfig(BaseModel):
    enabled: bool = False
    warning: float = 15.0
    critical: float = 10.0


class HysteresisConfig(BaseModel):
    enabled: bool = True
    threshold_gap: float = 0.5


class AlertConfig(BaseModel):
    enabled: bool = True
    evaluation_interval_seconds: int = 30
    stale_sensor_seconds: int = 120
    temperature: AlertThresholdConfig = AlertThresholdConfig()
    low_temperature: LowTemperatureConfig = LowTemperatureConfig()
    hysteresis: HysteresisConfig = HysteresisConfig()
    max_occurrence_count: int = 1000


class AnomalyDetectionConfig(BaseModel):
    enabled: bool = True
    rolling_window_size: int = 20
    min_samples: int = 5
    z_score_threshold: float = 3.0
    spike_threshold: float = 5.0
    drop_threshold: float = 5.0
    sustained_deviation_threshold: float = 2.5
    # A moderate deviation (above z_score_threshold, below spike/drop) must persist for this
    # many consecutive readings before it is reported as a "sustained deviation".
    sustained_min_readings: int = 3
    cooldown_seconds: int = 300
    recovery_window: int = 10
    warm_up_seconds: int = 60


class ReplayConfig(BaseModel):
    max_points_per_sensor: int = 600
    event_limit: int = 500
    context_window_minutes: int = 15


class ScenarioBoundsConfig(BaseModel):
    max_window_minutes: int = 1440
    step_seconds: int = 60
    baseline_offset: tuple[float, float] = (-10.0, 10.0)
    variation_scale: tuple[float, float] = (0.0, 5.0)
    power_setpoint_kw: tuple[float, float] = (0.0, 60.0)


class MaintenanceConfig(BaseModel):
    lookback_days: int = 7
    anomaly_count_flag: int = 3
    alert_recurrence_flag: int = 3
    time_in_warning_ratio: float = 0.25
    flapping_transitions: int = 4
    forecast_min_points: int = 12
    forecast_lookback_minutes: int = 30


class AuthUserConfig(BaseModel):
    username: str
    password: str
    role: str = "viewer"


class AuthConfig(BaseModel):
    enabled: bool = True
    # Dev-only default; override with the AUTH_SECRET environment variable.
    secret: str = "dev-only-change-me"
    token_minutes: int = 480
    users: list[AuthUserConfig] = Field(default_factory=list)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mqtt_broker: str = "localhost"
    mqtt_port: int = 1883
    mqtt_topic: str = "building/+/+"
    mqtt_client_id: str = "smart-building-backend"

    database_url: str = "sqlite:///./smart_building.db"

    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_debug: bool = True
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    temp_min: float = 20.0
    temp_max: float = 40.0
    threshold_normal: float = 30.0
    threshold_high: float = 35.0
    history_limit: int = 100
    activity_log_limit: int = 50

    topology: TopologyConfig = TopologyConfig()
    simulator: SimulatorConfig = SimulatorConfig()
    retention: RetentionConfig = RetentionConfig()
    aggregation: AggregationConfig = AggregationConfig()
    alerts: AlertConfig = AlertConfig()
    anomaly_detection: AnomalyDetectionConfig = AnomalyDetectionConfig()
    replay: ReplayConfig = ReplayConfig()
    scenario: ScenarioBoundsConfig = ScenarioBoundsConfig()
    maintenance: MaintenanceConfig = MaintenanceConfig()
    auth: AuthConfig = AuthConfig()

    @property
    def simulation_rooms(self) -> list[str]:
        """Room codes from the configured topology (the DB is authoritative at runtime)."""
        return self.topology.room_codes()

    @classmethod
    def from_yaml(cls, path: str = "config.yaml") -> "Settings":
        # CONFIG_PATH lets a container mount the file anywhere (the repo-relative search
        # below only works when running from a checkout).
        config_path = Path(os.getenv("CONFIG_PATH", path))
        if not config_path.is_absolute():
            current = Path(__file__).parent.parent.parent.parent
            while current != current.parent:
                candidate = current / path
                if candidate.exists():
                    config_path = candidate
                    break
                current = current.parent

        data: dict = {}
        if config_path.exists():
            with open(config_path) as f:
                data = yaml.safe_load(f) or {}

        mqtt = data.get("mqtt", {})
        app = data.get("app", {})
        sim = data.get("simulation", {})
        alerts = data.get("alerts", {})
        thresholds = alerts.get("thresholds", {})

        kwargs: dict = {
            "mqtt_broker": os.getenv("MQTT_BROKER", mqtt.get("broker", "localhost")),
            "mqtt_port": int(os.getenv("MQTT_PORT", mqtt.get("port", 1883))),
            "mqtt_topic": mqtt.get("topic", "building/+/+"),
            "mqtt_client_id": mqtt.get("client_id", "smart-building-backend"),
            "database_url": os.getenv(
                "DATABASE_URL", data.get("database", {}).get("url", "sqlite:///./smart_building.db")
            ),
            "app_host": app.get("host", "0.0.0.0"),
            "app_port": app.get("port", 8000),
            "app_debug": app.get("debug", True),
            "cors_origins": app.get(
                "cors_origins", ["http://localhost:5173", "http://127.0.0.1:5173"]
            ),
            "temp_min": sim.get("temperature_bounds", {}).get("min", 20.0),
            "temp_max": sim.get("temperature_bounds", {}).get("max", 40.0),
            "threshold_normal": sim.get("thresholds", {}).get("normal_max", 30.0),
            "threshold_high": sim.get("thresholds", {}).get("high_max", 35.0),
            "history_limit": sim.get("history_limit", 100),
            "activity_log_limit": sim.get("activity_log_limit", 50),
            "alerts": {
                "enabled": alerts.get("enabled", True),
                "evaluation_interval_seconds": alerts.get("evaluation_interval_seconds", 30),
                "stale_sensor_seconds": alerts.get("stale_sensor_seconds", 120),
                "temperature": thresholds.get("temperature", {}),
                "low_temperature": thresholds.get("low_temperature", {}),
                "hysteresis": alerts.get("hysteresis", {}),
                "max_occurrence_count": alerts.get("max_occurrence_count", 1000),
            },
        }
        # Sections whose YAML shape equals the model shape pass straight through.
        for key in (
            "topology",
            "simulator",
            "retention",
            "aggregation",
            "anomaly_detection",
            "replay",
            "scenario",
            "maintenance",
            "auth",
        ):
            if key in data and data[key] is not None:
                kwargs[key] = data[key]

        settings_obj = cls(**kwargs)
        if os.getenv("AUTH_SECRET"):
            settings_obj.auth.secret = os.environ["AUTH_SECRET"]
        if os.getenv("SIMULATOR_TRANSPORT"):
            settings_obj.simulator.transport = os.environ["SIMULATOR_TRANSPORT"]
        return settings_obj


settings = Settings.from_yaml()
