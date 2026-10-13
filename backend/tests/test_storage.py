from pathlib import Path

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from cagent_backend.storage import Database


def test_migrations_are_repeatable_and_leave_original_database_alone(tmp_path: Path):
    original = tmp_path / "cagent.sqlite"
    original.write_bytes(b"untouched original fixture")
    db = Database(f"sqlite:///{(tmp_path / 'backend' / 'application.sqlite').as_posix()}")
    db.migrate()
    db.migrate()
    assert {"knowledge_documents", "knowledge_chunks", "knowledge_index_jobs"} <= set(
        inspect(db.engine).get_table_names()
    )
    with db.engine.connect() as connection:
        assert (
            connection.scalar(text("SELECT version_num FROM alembic_version")) == "0001_knowledge"
        )
    assert original.read_bytes() == b"untouched original fixture"
    db.close()


def test_transaction_rolls_back_and_foreign_keys_are_enforced(tmp_path: Path):
    db = Database(f"sqlite:///{(tmp_path / 'application.sqlite').as_posix()}")
    db.migrate()
    with pytest.raises(RuntimeError):
        with db.transaction() as session:
            session.execute(text("CREATE TABLE transaction_probe (id INTEGER)"))
            session.execute(text("INSERT INTO transaction_probe VALUES (1)"))
            raise RuntimeError("intentional interruption")
    assert "transaction_probe" not in inspect(db.engine).get_table_names()
    with pytest.raises(IntegrityError):
        with db.transaction() as session:
            session.execute(
                text(
                    "INSERT INTO knowledge_chunks "
                    "(id, document_key, revision, ordinal, text, start_offset, end_offset) "
                    "VALUES ('orphan', 'missing', 1, 0, 'fixture', 0, 7)"
                )
            )
    db.close()


def test_postgres_driver_is_lazy_and_url_is_normalized():
    db = Database("postgresql://test:test@127.0.0.1:5432/cagent")
    assert db.url.drivername == "postgresql+psycopg"
    assert db._engine is None
    db.close()


def test_original_application_database_cannot_be_accidentally_reused(tmp_path: Path):
    with pytest.raises(ValueError, match="separate"):
        Database(f"sqlite:///{(tmp_path / 'cagent.sqlite').as_posix()}")
