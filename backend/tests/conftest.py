import contextlib
import os
import pytest
import tempfile

# Point the whole app at an isolated temp database BEFORE any app module is imported:
# `app.core.database.engine` is created at import time from DATABASE_URL.
_fd, _DB_PATH = tempfile.mkstemp(suffix=".db")
os.close(_fd)
os.environ["DATABASE_URL"] = f"sqlite:///{_DB_PATH}"

import app.models  # noqa: E402, F401  registers every table on Base.metadata
from app.core.database import Base, SessionLocal  # noqa: E402
from app.core.database import engine as app_engine  # noqa: E402
from app.services.topology_service import seed_topology  # noqa: E402


@pytest.fixture(scope="session")
def engine():
    Base.metadata.create_all(bind=app_engine)
    yield app_engine
    Base.metadata.drop_all(bind=app_engine)
    app_engine.dispose()
    with contextlib.suppress(OSError):
        os.unlink(_DB_PATH)


@pytest.fixture
def db_session(engine):
    """A session on the (emptied, then topology-seeded) isolated test database."""
    session = SessionLocal()
    for table in reversed(Base.metadata.sorted_tables):
        session.execute(table.delete())
    session.commit()
    seed_topology(session)
    yield session
    session.close()


@pytest.fixture(autouse=True)
def _reset_process_state():
    """Module-level singletons (login throttle, event bus) must not leak between tests."""
    from app.api import nexus

    nexus._failures.clear()
    yield
    nexus._failures.clear()


@pytest.fixture
def client(db_session):
    """HTTP client over the real app. No lifespan: no MQTT, simulator or worker threads."""
    from app.main import app
    from fastapi.testclient import TestClient

    return TestClient(app)


def _login(client, username: str, password: str) -> dict:
    res = client.post("/api/auth/login", json={"username": username, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


@pytest.fixture
def operator_headers(client):
    return _login(client, "operator", "operator-demo")


@pytest.fixture
def viewer_headers(client):
    return _login(client, "viewer", "viewer-demo")


@pytest.fixture
def admin_headers(client):
    return _login(client, "admin", "admin-demo")
