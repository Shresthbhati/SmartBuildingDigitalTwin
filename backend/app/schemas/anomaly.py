from datetime import datetime
from enum import StrEnum
from pydantic import BaseModel, Field


class APIAnomalyCategory(StrEnum):
    Z_SCORE_SPIKE = "z_score_spike"
    Z_SCORE_DROP = "z_score_drop"
    SUSTAINED_DEVIATION = "sustained_deviation"


class APIAnomalySeverity(StrEnum):
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class APIAnomalyStatus(StrEnum):
    OPEN = "OPEN"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    RESOLVED = "RESOLVED"


class AnomalyResponse(BaseModel):
    id: int
    room: str
    sensor_id: str
    anomaly_category: APIAnomalyCategory
    severity: APIAnomalySeverity
    title: str
    description: str
    status: APIAnomalyStatus
    detected_at: datetime
    last_observed_at: datetime
    acknowledged_at: datetime | None = None
    acknowledged_by: str | None = None
    resolved_at: datetime | None = None
    observed_value: float
    expected_baseline: float
    deviation_score: float
    occurrence_count: int
    metadata: dict | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AnomalyListItem(BaseModel):
    id: int
    room: str
    sensor_id: str
    anomaly_category: APIAnomalyCategory
    severity: APIAnomalySeverity
    title: str
    status: APIAnomalyStatus
    detected_at: datetime
    last_observed_at: datetime
    acknowledged_at: datetime | None = None
    resolved_at: datetime | None = None
    observed_value: float
    expected_baseline: float
    deviation_score: float
    occurrence_count: int

    class Config:
        from_attributes = True


class AnomalyFilter(BaseModel):
    room: str | None = None
    sensor_id: str | None = None
    anomaly_category: APIAnomalyCategory | None = None
    severity: APIAnomalySeverity | None = None
    status: APIAnomalyStatus | None = None
    start: datetime | None = None
    end: datetime | None = None
    limit: int = Field(default=50, ge=1, le=500)
    offset: int = Field(default=0, ge=0)
    sort_by: str = Field(default="detected_at")
    sort_order: str = Field(default="desc")


class AnomalyAcknowledgeRequest(BaseModel):
    actor: str | None = None


class AnomalyResolveRequest(BaseModel):
    actor: str | None = None


class AnomalyCountBySeverity(BaseModel):
    severity: APIAnomalySeverity
    count: int


class AnomalyCountByStatus(BaseModel):
    status: APIAnomalyStatus
    count: int


class AnomalyCountByCategory(BaseModel):
    category: APIAnomalyCategory
    count: int


class AnomalyCountsResponse(BaseModel):
    total: int
    by_severity: list[AnomalyCountBySeverity]
    by_status: list[AnomalyCountByStatus]
    by_category: list[AnomalyCountByCategory]
