import json
from datetime import UTC, datetime
from pydantic import BaseModel, model_validator
from typing import Any


class UTCModel(BaseModel):
    """Response model that always serialises datetimes as timezone-aware UTC.

    SQLite hands back naive datetimes that are really UTC; without an offset in the JSON a
    browser would read them as local time and show every event hours off.
    """

    @model_validator(mode="after")
    def _attach_utc(self):
        for name in type(self).model_fields:
            value = getattr(self, name)
            if isinstance(value, datetime) and value.tzinfo is None:
                object.__setattr__(self, name, value.replace(tzinfo=UTC))
        return self


def parse_json_metadata(value: Any) -> dict | None:
    """`metadata_json` is stored as JSON text; the API exposes it as a dict.

    ORM models can't expose a `metadata` attribute (it is reserved by SQLAlchemy's
    declarative base), so response schemas read `metadata_json` via validation_alias.
    """
    if value is None or isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None
