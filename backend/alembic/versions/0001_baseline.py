"""baseline: full schema incl. topology, lifecycle audit and scenario runs

Revision ID: 0001
Revises:
Create Date: 2026-10-22 22:05:47.194737
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the full schema. Idempotent per table: databases created by the pre-Alembic
    `create_all` already have the original tables, so existing tables are left untouched."""
    existing = set(sa.inspect(op.get_bind()).get_table_names())

    if "activity_log" not in existing:
        op.create_table(
            "activity_log",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("room", sa.String(length=50), nullable=False),
            sa.Column("message", sa.String(length=500), nullable=False),
            sa.Column("level", sa.String(length=20), nullable=False),
            sa.Column(
                "timestamp",
                sa.DateTime(timezone=True),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        with op.batch_alter_table("activity_log", schema=None) as batch_op:
            batch_op.create_index("ix_activity_log_room", ["room"], unique=False)
            batch_op.create_index("ix_activity_log_timestamp", ["timestamp"], unique=False)

    if "alerts" not in existing:
        op.create_table(
            "alerts",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("room", sa.String(length=50), nullable=False),
            sa.Column("sensor_id", sa.String(length=50), nullable=False),
            sa.Column(
                "alert_type",
                sa.Enum(
                    "HIGH_TEMPERATURE",
                    "CRITICAL_TEMPERATURE",
                    "LOW_TEMPERATURE",
                    "STALE_SENSOR",
                    "CONNECTIVITY_LOSS",
                    "INVALID_READING",
                    name="alerttype",
                ),
                nullable=False,
            ),
            sa.Column(
                "severity",
                sa.Enum("INFO", "WARNING", "CRITICAL", name="alertseverity"),
                nullable=False,
            ),
            sa.Column("title", sa.String(length=200), nullable=False),
            sa.Column("description", sa.Text(), nullable=False),
            sa.Column(
                "status",
                sa.Enum("OPEN", "ACKNOWLEDGED", "RESOLVED", name="alertstatus"),
                nullable=False,
            ),
            sa.Column("first_occurrence", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_occurrence", sa.DateTime(timezone=True), nullable=False),
            sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("acknowledged_by", sa.String(length=100), nullable=True),
            sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_reading_value", sa.Float(), nullable=True),
            sa.Column("threshold_value", sa.Float(), nullable=True),
            sa.Column("occurrence_count", sa.Integer(), nullable=False),
            sa.Column("metadata_json", sa.Text(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        with op.batch_alter_table("alerts", schema=None) as batch_op:
            batch_op.create_index(batch_op.f("ix_alerts_alert_type"), ["alert_type"], unique=False)
            batch_op.create_index(batch_op.f("ix_alerts_room"), ["room"], unique=False)
            batch_op.create_index("ix_alerts_room_status", ["room", "status"], unique=False)
            batch_op.create_index(batch_op.f("ix_alerts_sensor_id"), ["sensor_id"], unique=False)
            batch_op.create_index("ix_alerts_sensor_status", ["sensor_id", "status"], unique=False)
            batch_op.create_index(batch_op.f("ix_alerts_severity"), ["severity"], unique=False)
            batch_op.create_index(batch_op.f("ix_alerts_status"), ["status"], unique=False)
            batch_op.create_index("ix_alerts_type_status", ["alert_type", "status"], unique=False)

    if "anomaly_events" not in existing:
        op.create_table(
            "anomaly_events",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("room", sa.String(length=50), nullable=False),
            sa.Column("sensor_id", sa.String(length=50), nullable=False),
            sa.Column(
                "anomaly_category",
                sa.Enum(
                    "Z_SCORE_SPIKE", "Z_SCORE_DROP", "SUSTAINED_DEVIATION", name="anomalycategory"
                ),
                nullable=False,
            ),
            sa.Column(
                "severity",
                sa.Enum("INFO", "WARNING", "CRITICAL", name="anomalyseverity"),
                nullable=False,
            ),
            sa.Column("title", sa.String(length=200), nullable=False),
            sa.Column("description", sa.Text(), nullable=False),
            sa.Column(
                "status",
                sa.Enum("OPEN", "ACKNOWLEDGED", "RESOLVED", name="anomalystatus"),
                nullable=False,
            ),
            sa.Column("detected_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_observed_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("acknowledged_by", sa.String(length=100), nullable=True),
            sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("observed_value", sa.Float(), nullable=False),
            sa.Column("expected_baseline", sa.Float(), nullable=False),
            sa.Column("deviation_score", sa.Float(), nullable=False),
            sa.Column("occurrence_count", sa.Integer(), nullable=False),
            sa.Column("metadata_json", sa.Text(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("id"),
        )
        with op.batch_alter_table("anomaly_events", schema=None) as batch_op:
            batch_op.create_index(
                "ix_anomalies_category_status", ["anomaly_category", "status"], unique=False
            )
            batch_op.create_index("ix_anomalies_room_status", ["room", "status"], unique=False)
            batch_op.create_index(
                "ix_anomalies_sensor_status", ["sensor_id", "status"], unique=False
            )
            batch_op.create_index(
                batch_op.f("ix_anomaly_events_anomaly_category"), ["anomaly_category"], unique=False
            )
            batch_op.create_index(batch_op.f("ix_anomaly_events_room"), ["room"], unique=False)
            batch_op.create_index(
                batch_op.f("ix_anomaly_events_sensor_id"), ["sensor_id"], unique=False
            )
            batch_op.create_index(
                batch_op.f("ix_anomaly_events_severity"), ["severity"], unique=False
            )
            batch_op.create_index(batch_op.f("ix_anomaly_events_status"), ["status"], unique=False)

    if "buildings" not in existing:
        op.create_table(
            "buildings",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("code", sa.String(length=50), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("timezone", sa.String(length=64), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("code"),
        )

    if "lifecycle_events" not in existing:
        op.create_table(
            "lifecycle_events",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("entity_type", sa.String(length=20), nullable=False),
            sa.Column("entity_id", sa.Integer(), nullable=False),
            sa.Column("from_status", sa.String(length=20), nullable=True),
            sa.Column("to_status", sa.String(length=20), nullable=False),
            sa.Column("actor", sa.String(length=100), nullable=True),
            sa.Column("at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        with op.batch_alter_table("lifecycle_events", schema=None) as batch_op:
            batch_op.create_index("ix_lifecycle_at", ["at"], unique=False)
            batch_op.create_index("ix_lifecycle_entity", ["entity_type", "entity_id"], unique=False)

    if "room_status" not in existing:
        op.create_table(
            "room_status",
            sa.Column("room", sa.String(length=50), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("current_temperature", sa.Float(), nullable=True),
            sa.Column(
                "last_updated",
                sa.DateTime(timezone=True),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint("room"),
        )

    if "scenario_runs" not in existing:
        op.create_table(
            "scenario_runs",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("label", sa.String(length=200), nullable=True),
            sa.Column("created_by", sa.String(length=100), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.Column("sensor_id", sa.String(length=50), nullable=False),
            sa.Column("parameters_json", sa.Text(), nullable=False),
            sa.Column("result_json", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        with op.batch_alter_table("scenario_runs", schema=None) as batch_op:
            batch_op.create_index(
                batch_op.f("ix_scenario_runs_sensor_id"), ["sensor_id"], unique=False
            )

    if "sensor_readings" not in existing:
        op.create_table(
            "sensor_readings",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("room", sa.String(length=50), nullable=False),
            sa.Column("sensor_id", sa.String(length=50), nullable=False),
            sa.Column("measurement", sa.String(length=50), nullable=False),
            sa.Column("value", sa.Float(), nullable=False),
            sa.Column("unit", sa.String(length=20), nullable=False),
            sa.Column(
                "source",
                sa.Enum("SIMULATED", "MEASURED", "SCENARIO", name="readingsource"),
                nullable=False,
            ),
            sa.Column("event_timestamp", sa.DateTime(timezone=True), nullable=False),
            sa.Column(
                "ingestion_timestamp",
                sa.DateTime(timezone=True),
                server_default=sa.text("(CURRENT_TIMESTAMP)"),
                nullable=False,
            ),
            sa.Column("idempotency_key", sa.String(length=100), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("idempotency_key"),
        )
        with op.batch_alter_table("sensor_readings", schema=None) as batch_op:
            batch_op.create_index(
                "ix_sensor_readings_event_timestamp", ["event_timestamp"], unique=False
            )
            batch_op.create_index(
                "ix_sensor_readings_idempotency_key", ["idempotency_key"], unique=False
            )
            batch_op.create_index("ix_sensor_readings_measurement", ["measurement"], unique=False)
            batch_op.create_index("ix_sensor_readings_room", ["room"], unique=False)
            batch_op.create_index(
                "ix_sensor_readings_room_measurement", ["room", "measurement"], unique=False
            )
            batch_op.create_index(
                "ix_sensor_readings_room_sensor", ["room", "sensor_id"], unique=False
            )
            batch_op.create_index("ix_sensor_readings_sensor", ["sensor_id"], unique=False)
            batch_op.create_index(
                "ix_sensor_readings_sensor_timestamp",
                ["sensor_id", "event_timestamp"],
                unique=False,
            )

    if "floors" not in existing:
        op.create_table(
            "floors",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("building_id", sa.Integer(), nullable=False),
            sa.Column("level", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(length=100), nullable=False),
            sa.Column("elevation_m", sa.Float(), nullable=False),
            sa.Column("height_m", sa.Float(), nullable=False),
            sa.ForeignKeyConstraint(
                ["building_id"],
                ["buildings.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("building_id", "level", name="uq_floor_building_level"),
        )
        with op.batch_alter_table("floors", schema=None) as batch_op:
            batch_op.create_index(
                batch_op.f("ix_floors_building_id"), ["building_id"], unique=False
            )

    if "rooms" not in existing:
        op.create_table(
            "rooms",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("floor_id", sa.Integer(), nullable=False),
            sa.Column("code", sa.String(length=50), nullable=False),
            sa.Column("name", sa.String(length=100), nullable=False),
            sa.Column("x", sa.Float(), nullable=False),
            sa.Column("z", sa.Float(), nullable=False),
            sa.Column("width", sa.Float(), nullable=False),
            sa.Column("depth", sa.Float(), nullable=False),
            sa.ForeignKeyConstraint(
                ["floor_id"],
                ["floors.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("code"),
        )
        with op.batch_alter_table("rooms", schema=None) as batch_op:
            batch_op.create_index(batch_op.f("ix_rooms_floor_id"), ["floor_id"], unique=False)

    if "assets" not in existing:
        op.create_table(
            "assets",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("floor_id", sa.Integer(), nullable=False),
            sa.Column("room_id", sa.Integer(), nullable=True),
            sa.Column("code", sa.String(length=50), nullable=False),
            sa.Column("kind", sa.String(length=50), nullable=False),
            sa.Column("name", sa.String(length=100), nullable=False),
            sa.Column("x", sa.Float(), nullable=False),
            sa.Column("z", sa.Float(), nullable=False),
            sa.ForeignKeyConstraint(
                ["floor_id"],
                ["floors.id"],
            ),
            sa.ForeignKeyConstraint(
                ["room_id"],
                ["rooms.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("code"),
        )
        with op.batch_alter_table("assets", schema=None) as batch_op:
            batch_op.create_index(batch_op.f("ix_assets_floor_id"), ["floor_id"], unique=False)
            batch_op.create_index(batch_op.f("ix_assets_room_id"), ["room_id"], unique=False)

    if "sensors" not in existing:
        op.create_table(
            "sensors",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("room_id", sa.Integer(), nullable=True),
            sa.Column("asset_id", sa.Integer(), nullable=True),
            sa.Column("sensor_id", sa.String(length=50), nullable=False),
            sa.Column("type", sa.String(length=50), nullable=False),
            sa.Column("unit", sa.String(length=20), nullable=False),
            sa.Column("source", sa.String(length=20), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("baseline", sa.Float(), nullable=True),
            sa.Column("variation", sa.Float(), nullable=True),
            sa.Column("min_value", sa.Float(), nullable=True),
            sa.Column("max_value", sa.Float(), nullable=True),
            sa.ForeignKeyConstraint(
                ["asset_id"],
                ["assets.id"],
            ),
            sa.ForeignKeyConstraint(
                ["room_id"],
                ["rooms.id"],
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("sensor_id"),
        )
        with op.batch_alter_table("sensors", schema=None) as batch_op:
            batch_op.create_index(batch_op.f("ix_sensors_asset_id"), ["asset_id"], unique=False)
            batch_op.create_index(batch_op.f("ix_sensors_room_id"), ["room_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("sensors", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_sensors_room_id"))
        batch_op.drop_index(batch_op.f("ix_sensors_asset_id"))

    op.drop_table("sensors")
    with op.batch_alter_table("assets", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_assets_room_id"))
        batch_op.drop_index(batch_op.f("ix_assets_floor_id"))

    op.drop_table("assets")
    with op.batch_alter_table("rooms", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_rooms_floor_id"))

    op.drop_table("rooms")
    with op.batch_alter_table("floors", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_floors_building_id"))

    op.drop_table("floors")
    with op.batch_alter_table("sensor_readings", schema=None) as batch_op:
        batch_op.drop_index("ix_sensor_readings_sensor_timestamp")
        batch_op.drop_index("ix_sensor_readings_sensor")
        batch_op.drop_index("ix_sensor_readings_room_sensor")
        batch_op.drop_index("ix_sensor_readings_room_measurement")
        batch_op.drop_index("ix_sensor_readings_room")
        batch_op.drop_index("ix_sensor_readings_measurement")
        batch_op.drop_index("ix_sensor_readings_idempotency_key")
        batch_op.drop_index("ix_sensor_readings_event_timestamp")

    op.drop_table("sensor_readings")
    with op.batch_alter_table("scenario_runs", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_scenario_runs_sensor_id"))

    op.drop_table("scenario_runs")
    op.drop_table("room_status")
    with op.batch_alter_table("lifecycle_events", schema=None) as batch_op:
        batch_op.drop_index("ix_lifecycle_entity")
        batch_op.drop_index("ix_lifecycle_at")

    op.drop_table("lifecycle_events")
    op.drop_table("buildings")
    with op.batch_alter_table("anomaly_events", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_anomaly_events_status"))
        batch_op.drop_index(batch_op.f("ix_anomaly_events_severity"))
        batch_op.drop_index(batch_op.f("ix_anomaly_events_sensor_id"))
        batch_op.drop_index(batch_op.f("ix_anomaly_events_room"))
        batch_op.drop_index(batch_op.f("ix_anomaly_events_anomaly_category"))
        batch_op.drop_index("ix_anomalies_sensor_status")
        batch_op.drop_index("ix_anomalies_room_status")
        batch_op.drop_index("ix_anomalies_category_status")

    op.drop_table("anomaly_events")
    with op.batch_alter_table("alerts", schema=None) as batch_op:
        batch_op.drop_index("ix_alerts_type_status")
        batch_op.drop_index(batch_op.f("ix_alerts_status"))
        batch_op.drop_index(batch_op.f("ix_alerts_severity"))
        batch_op.drop_index("ix_alerts_sensor_status")
        batch_op.drop_index(batch_op.f("ix_alerts_sensor_id"))
        batch_op.drop_index("ix_alerts_room_status")
        batch_op.drop_index(batch_op.f("ix_alerts_room"))
        batch_op.drop_index(batch_op.f("ix_alerts_alert_type"))

    op.drop_table("alerts")
    with op.batch_alter_table("activity_log", schema=None) as batch_op:
        batch_op.drop_index("ix_activity_log_timestamp")
        batch_op.drop_index("ix_activity_log_room")

    op.drop_table("activity_log")
