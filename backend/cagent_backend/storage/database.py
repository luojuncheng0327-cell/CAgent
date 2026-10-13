from contextlib import contextmanager
from pathlib import Path
from threading import RLock

from alembic.config import Config
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from alembic import command


class Database:
    """Own only the new backend database; never migrate the worker's cagent.sqlite."""

    def __init__(self, database_url: str):
        self.url = make_url(database_url)
        if self.url.drivername in {"postgres", "postgresql"}:
            self.url = self.url.set(drivername="postgresql+psycopg")
        if self.url.get_backend_name() not in {"sqlite", "postgresql"}:
            raise ValueError("The application database must use SQLite or PostgreSQL")
        if self.url.get_backend_name() == "sqlite" and self.url.database:
            if Path(self.url.database).name.lower() == "cagent.sqlite":
                raise ValueError("Use a separate backend application database, not cagent.sqlite")
        self._engine: Engine | None = None
        self._lock = RLock()

    @property
    def engine(self) -> Engine:
        with self._lock:
            if self._engine is None:
                kwargs: dict = {"pool_pre_ping": True}
                if self.url.get_backend_name() == "sqlite":
                    if self.url.database and self.url.database != ":memory:":
                        Path(self.url.database).parent.mkdir(parents=True, exist_ok=True)
                    kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
                    if not self.url.database or self.url.database == ":memory:":
                        kwargs["poolclass"] = StaticPool
                self._engine = create_engine(self.url, **kwargs)
                if self.url.get_backend_name() == "sqlite":
                    # Python sqlite's legacy transaction mode otherwise commits DDL separately.
                    @event.listens_for(self._engine, "connect")
                    def enable_sqlite_transactions(connection, _):
                        connection.isolation_level = None
                        connection.execute("PRAGMA foreign_keys=ON")
                        connection.execute("PRAGMA busy_timeout=30000")

                    @event.listens_for(self._engine, "begin")
                    def explicit_begin(connection):
                        connection.exec_driver_sql("BEGIN")

            return self._engine

    def migrate(self) -> None:
        with self._lock:
            backend = Path(__file__).resolve().parents[2]
            package = Path(__file__).resolve().parents[1]
            script = backend / "alembic"
            ini = backend / "alembic.ini"
            if not (script / "env.py").is_file():
                script = package / "_migrations"
                ini = package / "_alembic.ini"
            config = Config(str(ini))
            config.set_main_option("script_location", str(script))
            with self.engine.begin() as connection:
                config.attributes["connection"] = connection
                command.upgrade(config, "head")

    @contextmanager
    def transaction(self):
        with self._lock, Session(self.engine, expire_on_commit=False) as session, session.begin():
            yield session

    def close(self) -> None:
        with self._lock:
            if self._engine is not None:
                self._engine.dispose()
                self._engine = None
