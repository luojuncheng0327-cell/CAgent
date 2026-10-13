from dataclasses import asdict
from pathlib import Path

import pytest
from sqlalchemy import select

from cagent_backend.knowledge import (
    KnowledgeError,
    KnowledgeService,
    Namespace,
    Neo4jGraphStore,
    QdrantVectorStore,
    split_text,
)
from cagent_backend.storage import Database
from cagent_backend.storage.models import IndexJob


@pytest.fixture
def service(tmp_path: Path):
    database = Database(f"sqlite:///{(tmp_path / 'application.sqlite').as_posix()}")
    database.migrate()
    vectors = QdrantVectorStore(path=tmp_path / "vectors")
    knowledge = KnowledgeService(database, vectors)
    yield knowledge
    knowledge.close()
    database.close()


def scope(agent: str = "assistant", tenant: str = "local", space: str = "notes") -> Namespace:
    return Namespace(tenant, agent, space)


def test_qdrant_ingest_search_update_and_delete_use_real_local_index(service):
    first = service.ingest_text(scope(), "document", "alpha fixture", vectors=[[1.0, 0.0]])
    assert first.revision == 1 and first.vector_status == "indexed"
    hit = service.search(scope(), query_vector=[1.0, 0.0])
    assert hit.method == "vector" and hit.hits[0].document_id == "document"
    assert hit.hits[0].text == "alpha fixture" and hit.hits[0].start_offset == 0
    repeated = service.ingest_text(scope(), "document", "alpha fixture", vectors=[[1.0, 0.0]])
    assert repeated.revision == 1 and repeated.unchanged
    changed = service.ingest_text(scope(), "document", "beta fixture", vectors=[[0.0, 1.0]])
    assert changed.revision == 2
    assert {item.revision for item in service.search(scope(), query_vector=[0.0, 1.0]).hits} == {2}
    assert service.search(scope(), query_text="alpha").hits == []
    assert service.delete_document(scope(), "document").deleted
    assert service.search(scope(), query_vector=[1.0, 0.0]).hits == []
    assert service.get_document(scope(), "document") is None


@pytest.mark.parametrize(
    "other", [scope(agent="other"), scope(tenant="other"), scope(space="other")]
)
def test_each_namespace_dimension_is_isolated(service, other):
    service.ingest_text(scope(), "same", "secret fixture", vectors=[[1.0, 0.0]])
    service.ingest_text(other, "same", "public fixture", vectors=[[1.0, 0.0]])
    hits = service.search(other, query_vector=[1.0, 0.0]).hits
    assert len(hits) == 1 and hits[0].text == "public fixture"
    assert service.search(other, query_text="secret").hits == []
    service.delete_document(other, "same")
    assert service.get_document(scope(), "same").text == "secret fixture"


def test_failed_index_is_durable_and_stale_jobs_cannot_resurrect_deleted_content(service):
    original = service.vector_store.upsert
    service.vector_store.upsert = lambda *args, **kwargs: (_ for _ in ()).throw(
        RuntimeError("private credential must not appear in public error")
    )
    first = service.ingest_text(scope(), "doc", "old text", vectors=[[1.0, 0.0]])
    assert first.vector_status == "pending"
    assert service.get_document(scope(), "doc").text == "old text"
    assert service.search(scope(), query_vector=[1.0, 0.0]).hits == []
    latest = service.ingest_text(scope(), "doc", "new text", vectors=[[0.0, 1.0]])
    assert latest.revision == 2
    service.vector_store.upsert = original
    processed = service.process_pending()
    assert processed.failed == 0
    hits = service.search(scope(), query_vector=[0.0, 1.0]).hits
    assert len(hits) == 1 and hits[0].text == "new text" and hits[0].revision == 2
    with service.database.transaction() as session:
        assert not any(
            "credential" in (job.last_error or "") for job in session.scalars(select(IndexJob))
        )
    service.delete_document(scope(), "doc")
    service.process_pending()
    assert service.search(scope(), query_vector=[1.0, 0.0]).hits == []


def test_local_qdrant_data_and_pending_outbox_survive_restart(tmp_path: Path):
    url = f"sqlite:///{(tmp_path / 'application.sqlite').as_posix()}"
    db = Database(url)
    db.migrate()
    first = KnowledgeService(db, QdrantVectorStore(path=tmp_path / "vectors"))
    first.ingest_text(scope(), "persist", "restart text", vectors=[[1.0, 0.0]])
    first.close()
    db.close()
    reopened = Database(url)
    reopened.migrate()
    second = KnowledgeService(reopened, QdrantVectorStore(path=tmp_path / "vectors"))
    try:
        assert second.search(scope(), query_vector=[1.0, 0.0]).hits[0].text == "restart text"
    finally:
        second.close()
        reopened.close()


def test_text_only_import_and_search_are_operational_and_explicitly_lexical(service):
    imported = service.ingest_text(scope(), "plain", "LangGraph 节点恢复与知识库")
    assert imported.vector_status == "not_configured"
    result = service.search(scope(), query_text="节点恢复")
    assert result.method == "lexical" and result.hits[0].document_id == "plain"
    assert asdict(result)["hits"][0]["chunk_id"]


def test_injected_embedder_handles_real_embedding_contract_without_network(service):
    class FixtureEmbedder:
        identity = "fixture:v1"

        def embed_documents(self, texts):
            return [[0.0, 1.0] for _ in texts]

        def embed_query(self, text):
            return [0.0, 1.0]

    service.embedder = FixtureEmbedder()
    service.ingest_text(scope(), "embedded", "semantic fixture")
    assert service.search(scope(), query_text="different terms").method == "vector"
    assert service.search(scope(), query_text="different terms").hits[0].document_id == "embedded"


@pytest.mark.parametrize("vector", [[float("nan"), 0.0], [0.0, 0.0], [], [True, 1.0]])
def test_invalid_vectors_are_rejected_before_source_is_saved(service, vector):
    with pytest.raises(KnowledgeError):
        service.ingest_text(scope(), "invalid", "fixture", vectors=[vector])
    assert service.get_document(scope(), "invalid") is None


def test_source_hash_includes_metadata_graph_and_vector_changes(service):
    service.ingest_text(scope(), "version", "fixture", metadata={"title": "one"})
    second = service.ingest_text(scope(), "version", "fixture", metadata={"title": "two"})
    assert second.revision == 2
    third = service.ingest_text(scope(), "version", "fixture", vectors=[[1.0, 0.0]])
    assert third.revision == 3


def test_bounds_and_input_identity_are_validated(service):
    with pytest.raises(KnowledgeError):
        Namespace("", "assistant", "notes")
    with pytest.raises(KnowledgeError):
        service.ingest_text(scope(), "doc", " " * 10)
    with pytest.raises(KnowledgeError):
        service.search(scope(), query_vector=[1.0, 0.0], limit=101)
    with pytest.raises(KnowledgeError):
        service.ingest_text(scope(), "doc", "x" * 2400, vectors=[[1.0, 0.0]])
    chunks = split_text("x" * 2400)
    assert len(chunks) == 3 and chunks[1].start_offset < chunks[0].end_offset


def test_optional_graph_failure_keeps_document_and_pending_job(service):
    class OfflineGraph:
        def upsert(self, *args):
            raise RuntimeError("fixture service unavailable")

        def close(self):
            pass

    service.graph_store = OfflineGraph()
    record = service.ingest_text(
        scope(), "graph", "entity text", graph={"entities": [{"id": "a", "name": "Alice"}]}
    )
    assert record.graph_status == "pending"
    assert service.get_document(scope(), "graph").text == "entity text"
    assert service.process_pending().failed == 1


def test_graph_queries_are_parameterized_bounded_and_require_document_provenance():
    class FakeResult:
        def data(self):
            return []

        def consume(self):
            return None

    class FakeTransaction:
        def __init__(self):
            self.calls = []

        def run(self, query, **params):
            self.calls.append((query, params))
            return FakeResult()

    class FakeSession:
        def __init__(self, transaction):
            self.transaction = transaction

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def execute_write(self, fn):
            return fn(self.transaction)

        def execute_read(self, fn):
            return fn(self.transaction)

    class FakeDriver:
        def __init__(self):
            self.transaction = FakeTransaction()

        def session(self, **kwargs):
            return FakeSession(self.transaction)

        def close(self):
            pass

    driver = FakeDriver()
    store = Neo4jGraphStore("bolt://127.0.0.1:7687", "neo4j", "fixture", driver=driver)
    malicious = "Alice') MATCH (n) DETACH DELETE n //"
    store.upsert(
        scope(),
        "doc-key",
        "doc",
        1,
        {
            "entities": [{"id": "a", "name": malicious, "kind": "Person", "chunk_ids": ["c1"]}],
            "relations": [],
        },
    )
    store.neighbors(scope(), "a", document_versions=["doc-key:1"], limit=5)
    assert driver.transaction.calls
    assert all(malicious not in query for query, params in driver.transaction.calls)
    assert any(malicious in str(params) for query, params in driver.transaction.calls)
    query, params = driver.transaction.calls[-1]
    assert params["limit"] == 5 and params["tenant_id"] == "local"
    assert params["agent_id"] == "assistant" and params["space_id"] == "notes"
    assert params["document_versions"] == ["doc-key:1"]
    assert "LIMIT $limit" in query
    store.close()


def test_worker_drain_executes_actual_pending_index_without_broker(service, monkeypatch):
    pytest.importorskip("celery")
    from cagent_backend.knowledge import jobs, runtime

    original = service.vector_store.upsert
    service.vector_store.upsert = lambda *args, **kwargs: (_ for _ in ()).throw(
        RuntimeError("offline")
    )
    assert (
        service.ingest_text(scope(), "worker", "worker fixture", vectors=[[1.0, 0.0]]).vector_status
        == "pending"
    )
    service.vector_store.upsert = original
    monkeypatch.setenv("CAGENT_REDIS_URL", "redis://127.0.0.1:6379/15")
    monkeypatch.setattr(runtime, "build_service", lambda: service)
    monkeypatch.setattr(service, "close", lambda: None)
    monkeypatch.setattr(service.database, "close", lambda: None)
    jobs.celery_app.cache_clear()
    app, task = jobs.register_index_task()
    app.conf.update(task_always_eager=True, task_store_eager_result=False)
    result = task.apply().get(propagate=True)
    assert result["processed"] == 1 and result["failed"] == 0
    assert service.search(scope(), query_vector=[1.0, 0.0]).hits[0].document_id == "worker"
    app.close()
    jobs.celery_app.cache_clear()


def test_worker_configuration_never_guesses_real_personal_data(monkeypatch):
    from cagent_backend.knowledge.runtime import build_service

    monkeypatch.delenv("CAGENT_DATABASE_URL", raising=False)
    monkeypatch.delenv("CAGENT_QDRANT_URL", raising=False)
    with pytest.raises(RuntimeError, match="requires"):
        build_service()


def test_same_query_dimensions_but_different_embedding_models_are_isolated(service):
    class Embedder:
        def __init__(self, identity):
            self.identity = identity

        def embed_documents(self, texts):
            return [[1.0, 0.0] for _ in texts]

        def embed_query(self, query):
            return [1.0, 0.0]

    service.embedder = Embedder("fixture-model-a")
    service.ingest_text(scope(), "a", "embedding model a")
    service.embedder = Embedder("fixture-model-b")
    assert service.search(scope(), query_text="query").hits == []
    service.ingest_text(scope(), "b", "embedding model b")
    assert [hit.document_id for hit in service.search(scope(), query_text="query").hits] == ["b"]


def test_literal_percent_underscore_and_unicode_queries_are_not_sql_wildcards(service):
    service.ingest_text(scope(), "literal", "50%_折扣与知识库")
    service.ingest_text(scope(), "other", "50元折扣与资料")
    assert [hit.document_id for hit in service.search(scope(), query_text="%_").hits] == ["literal"]


def test_graph_source_provenance_is_not_taken_from_other_documents(service):
    with pytest.raises(KnowledgeError, match="provenance"):
        service.ingest_text(
            scope(),
            "graph-invalid",
            "fixture",
            graph={"entities": [{"id": "a", "name": "Alice", "chunk_ids": ["foreign"]}]},
        )
    assert service.get_document(scope(), "graph-invalid") is None


def test_index_downtime_cannot_make_pending_source_queryable_as_verified_vectors(service):
    original = service.vector_store.upsert

    def write_then_fail(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("lost acknowledgement")

    service.vector_store.upsert = write_then_fail
    assert (
        service.ingest_text(scope(), "ack", "fixture", vectors=[[1.0, 0.0]]).vector_status
        == "pending"
    )
    assert service.search(scope(), query_vector=[1.0, 0.0]).hits == []
    service.vector_store.upsert = original
    service.process_pending()
    assert service.search(scope(), query_vector=[1.0, 0.0]).hits[0].document_id == "ack"


def test_enabling_optional_graph_can_index_previously_imported_source_without_rewriting(service):
    graph = {"entities": [{"id": "a", "name": "Alice"}]}
    first = service.ingest_text(scope(), "enable-graph", "source", graph=graph)
    assert first.graph_status == "not_configured"

    class RecordingGraph:
        def __init__(self):
            self.imported = []

        def upsert(self, *args):
            self.imported.append(args)

        def close(self):
            pass

    store = RecordingGraph()
    service.graph_store = store
    repeated = service.ingest_text(scope(), "enable-graph", "source", graph=graph)
    assert repeated.unchanged and repeated.revision == first.revision
    assert repeated.graph_status == "indexed" and len(store.imported) == 1


def test_import_acknowledges_its_own_revision_when_document_deleted_during_index(
    service, monkeypatch
):
    original_process = service.process_pending
    intercepted = []

    def process_with_delete(*args, **kwargs):
        if not intercepted:
            intercepted.append(True)
            service.delete_document(scope(), "race")
        return original_process(*args, **kwargs)

    monkeypatch.setattr(service, "process_pending", process_with_delete)
    accepted = service.ingest_text(scope(), "race", "accepted source", vectors=[[1.0, 0.0]])
    assert accepted.revision == 1 and accepted.text == "accepted source"
    assert service.get_document(scope(), "race") is None


def test_successful_outbox_drain_discards_redundant_payload_content(service):
    service.ingest_text(
        scope(),
        "payload",
        "source",
        vectors=[[1.0, 0.0]],
        graph={"entities": [{"id": "a", "name": "private name"}]},
    )
    with service.database.transaction() as session:
        jobs = session.scalars(select(IndexJob).where(IndexJob.status == "done")).all()
        assert jobs and all(job.payload_json == "{}" for job in jobs)


def test_opt_in_langchain_embedding_bridge_uses_only_configured_local_service(service):
    import json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread

    from cagent_backend.knowledge import OpenAICompatibleEmbedder

    calls = []

    class FixtureHTTPHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, body))
            inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
            response = json.dumps(
                {
                    "object": "list",
                    "model": body["model"],
                    "data": [
                        {"index": index, "object": "embedding", "embedding": [1.0, 0.0]}
                        for index, _ in enumerate(inputs)
                    ],
                    "usage": {"prompt_tokens": 2, "total_tokens": 2},
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHTTPHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        service.embedder = OpenAICompatibleEmbedder(
            f"http://127.0.0.1:{server.server_port}/v1",
            "fixture-embedding",
            "fixture-key",
        )
        assert calls == []
        result = service.ingest_text(scope(), "bridge", "LangChain bridge fixture")
        assert result.vector_status == "indexed"
        assert (
            service.search(scope(), query_text="configured embedding query").hits[0].document_id
            == "bridge"
        )
        assert all(
            path == "/v1/embeddings" and body["model"] == "fixture-embedding"
            for path, body in calls
        )
        assert all(isinstance(body["input"][0], str) for _, body in calls)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_document_list_is_scoped_bounded_and_omits_source_content(service):
    service.ingest_text(
        scope(), "local", "private text", metadata={"title": "项目说明", "private": "hidden"}
    )
    service.ingest_text(scope(), "deleted", "delete fixture")
    service.delete_document(scope(), "deleted")
    service.ingest_text(scope(agent="other"), "other", "other source")
    service.ingest_text(scope(tenant="other"), "tenant", "other tenant")
    service.ingest_text(scope(space="other"), "space", "other space")
    result = service.list_documents(scope())
    assert len(result["documents"]) == 1 and result["documents"][0]["document_id"] == "local"
    assert result["documents"][0]["title"] == "项目说明"
    assert result["documents"][0]["chunk_count"] == 1
    assert "text" not in result["documents"][0] and "metadata" not in result["documents"][0]
    service.ingest_text(scope(), "second", "second fixture")
    limited = service.list_documents(scope(), limit=1)
    assert len(limited["documents"]) == 1 and limited["truncated"]
    with pytest.raises(KnowledgeError):
        service.list_documents(scope(), limit=101)
