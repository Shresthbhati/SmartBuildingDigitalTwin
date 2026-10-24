from app.core.database import Base
from sqlalchemy import Column, DateTime, Integer, String, Text
from sqlalchemy.sql import func


class ScenarioRun(Base):
    """A saved what-if run. Results live here only; they never enter `sensor_readings`."""

    __tablename__ = "scenario_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    label = Column(String(200), nullable=True)
    created_by = Column(String(100), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    sensor_id = Column(String(50), nullable=False, index=True)
    parameters_json = Column(Text, nullable=False)
    result_json = Column(Text, nullable=False)
