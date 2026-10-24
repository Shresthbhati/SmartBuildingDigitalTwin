from app.core.config import settings
from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},
    echo=False,  # SQL echo floods logs and the recent-errors buffer; enable ad hoc when debugging
)


if engine.url.get_backend_name() == "sqlite":

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        # Several worker threads (MQTT, alerts, anomalies, simulator) write concurrently.
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    Base.metadata.create_all(bind=engine)
