from app.core.database import Base
from sqlalchemy import Column, DateTime, Index, Integer, String


class EventLifecycleEvent(Base):
    """Append-only audit row written on every alert/anomaly status transition.

    Replay reads these rows so the history of "who changed what, when" is exact
    rather than reconstructed from the latest model state.
    """

    __tablename__ = "lifecycle_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    entity_type = Column(String(20), nullable=False)  # "alert" | "anomaly"
    entity_id = Column(Integer, nullable=False)
    from_status = Column(String(20), nullable=True)  # None for creation
    to_status = Column(String(20), nullable=False)
    actor = Column(String(100), nullable=True)
    at = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index("ix_lifecycle_entity", "entity_type", "entity_id"),
        Index("ix_lifecycle_at", "at"),
    )
