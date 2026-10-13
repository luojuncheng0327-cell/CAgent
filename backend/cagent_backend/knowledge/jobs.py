"""Optional server worker bridge. Importing this module does not contact Redis."""

from __future__ import annotations

import os
from functools import lru_cache


@lru_cache(maxsize=1)
def celery_app():
    try:
        from celery import Celery
    except ImportError as error:  # celery stays an optional server dependency
        raise RuntimeError("Install the backend server worker extra to enable Celery") from error
    broker = os.environ.get("CAGENT_REDIS_URL")
    if not broker:
        raise RuntimeError("CAGENT_REDIS_URL is required for the server worker")
    app = Celery("cagent_knowledge", broker=broker, backend=broker)
    app.conf.update(
        task_serializer="json",
        accept_content=["json"],
        result_serializer="json",
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        task_time_limit=300,
    )
    return app


def register_index_task():
    """Register a bounded outbox drain using a factory, so secrets never enter task arguments."""
    app = celery_app()

    @app.task(name="cagent.knowledge.process_pending", bind=True, max_retries=3)
    def process_pending(task):
        from cagent_backend.knowledge.runtime import build_service

        service = None
        try:
            service = build_service()
            result = service.process_pending(limit=100)
            if result.failed:
                raise RuntimeError("knowledge index unavailable")
            return result.__dict__
        except Exception:
            raise task.retry(
                exc=RuntimeError("knowledge index unavailable"), countdown=2**task.request.retries
            ) from None
        finally:
            if service is not None:
                service.close()
                service.database.close()

    return app, process_pending


def __getattr__(name):
    if name == "app":
        return register_index_task()[0]
    raise AttributeError(name)
