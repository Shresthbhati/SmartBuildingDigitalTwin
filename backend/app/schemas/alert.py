from datetime import datetime
from enum import StrEnum
from pydantic import BaseModel, Field


class APIAlertType(StrEnum):
    HIGH_TEMPERATURE = "high_temperature"
    CRITICAL_TEMPERATURE = "critical_temperature"
    LOW_TEMPERATURE = "low_temperature"
    STALE_SENSOR = "stale_sensor"
    CONNECTIVITY_LOSS = "connectivity_loss"
    INVALID_READING = "invalid_reading"


class APIAlertSeverity(StrEnum):
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class APIAlertStatus(StrEnum):
    OPEN = "OPEN"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    RESOLVED = "RESOLVED"


class AlertResponse(BaseModel):
    id: int
    room: str
    sensor_id: str
    alert_type: APIAlertType
    severity: APIAlertSeverity
    title: str
    description: str
    status: APIAlertStatus
    first_occurrence: datetime
    last_occurrence: datetime
    acknowledged_at: datetime | None = None
    acknowledged_by: str | None = None
    resolved_at: datetime | None = None
    last_reading_value: float | None = None
    threshold_value: float | None = None
    occurrence_count: int
    metadata: dict | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AlertListItem(BaseModel):
    id: int
    room: str
    sensor_id: str
    alert_type: APIAlertType
    severity: APIAlertSeverity
    title: str
    status: APIAlertStatus
    first_occurrence: datetime
    last_occurrence: datetime
    acknowledged_at: datetime | None = None
    resolved_at: datetime | None = None
    last_reading_value: float | None = None
    occurrence_count: int

    class Config:
        from_attributes = True


class AlertFilter(BaseModel):
    room: str | None = None
    sensor_id: str | None = None
    alert_type: APIAlertType | None = None
    severity: APIAlertSeverity | None = None
    status: APIAlertStatus | None = None
    limit: int = Field(default=50, ge=1, le=500)
    offset: int = Field(default=0, ge=0)
    sort_by: str = Field(default="last_occurrence")
    sort_order: str = Field(default="desc")


class AlertAcknowledgeRequest(BaseModel):
    actor: str | None = None


class AlertResolveRequest(BaseModel):
    actor: str | None = None


class AlertCountBySeverity(BaseModel):
    severity: APIAlertSeverity
    count: int


class AlertCountByStatus(BaseModel):
    status: APIAlertStatus
    count: int


class AlertCountsResponse(BaseModel):
    total: int
    by_severity: list[AlertCountBySeverity]
    by_status: list[AlertCountByStatus]
