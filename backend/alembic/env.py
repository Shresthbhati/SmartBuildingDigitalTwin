import app.models  # noqa: F401  registers every table on Base.metadata
from alembic import context
from app.core.config import settings
from app.core.database import Base
from sqlalchemy import create_engine, pool

config = context.config
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=settings.database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    # The app passes its own connection so in-memory/test databases migrate in place.
    connection = config.attributes.get("connection")
    if connection is not None:
        _migrate(connection)
        return
    engine = create_engine(settings.database_url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        _migrate(connection)


def _migrate(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True)
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
