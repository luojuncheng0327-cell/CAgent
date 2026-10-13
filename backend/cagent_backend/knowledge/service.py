import json
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from threading import RLock
from uuid import NAMESPACE_URL, uuid4, uuid5

from sqlalchemy import and_, delete, func, or_, select

from cagent_backend.storage import Database
from cagent_backend.storage.models import Chunk, Document, IndexJob

from .graph import validate_graph
from .types import (
    DeleteResult,
    DocumentRecord,
    KnowledgeError,
    Namespace,
    ProcessResult,
    SearchHit,
    SearchResult,
    split_text,
    validate_identity,
    validate_vector,
)


def _json(value):
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        )
    except (TypeError, ValueError) as error:
        raise KnowledgeError("Metadata and graph data must be JSON values") from error


def _now():
    return datetime.now(UTC).isoformat()


def _scope(namespace: Namespace):
    return and_(
        Document.tenant_id == namespace.tenant_id,
        Document.agent_id == namespace.agent_id,
        Document.space_id == namespace.space_id,
    )


class KnowledgeService:
    """SQL owns documents; indexes are eventually consistent and checked against SQL versions."""

    def __init__(self, database: Database, vector_store, graph_store=None, embedder=None):
        self.database = database
        self.vector_store = vector_store
        self.graph_store = graph_store
        self.embedder = embedder
        self._lock = RLock()

    @staticmethod
    def _key(namespace, document_id):
        validate_identity(document_id, "document_id", 256)
        return sha256(_json([*namespace.payload().values(), document_id]).encode()).hexdigest()

    @staticmethod
    def _job(session, document, target, action, payload, revision=None):
        session.add(
            IndexJob(
                id=str(uuid4()),
                document_key=document.key,
                revision=document.revision if revision is None else revision,
                target=target,
                action=action,
                payload_json=_json(payload),
                status="pending",
                attempts=0,
                created_at=_now(),
            )
        )

    @staticmethod
    def _record(session, document, *, unchanged=False):
        chunks = session.scalars(
            select(Chunk).where(
                Chunk.document_key == document.key, Chunk.revision == document.revision
            )
        ).all()
        return DocumentRecord(
            document.document_id,
            document.revision,
            document.source_hash,
            document.text,
            json.loads(document.metadata_json),
            len(chunks),
            document.vector_status,
            document.graph_status,
            unchanged,
        )

    def ingest_text(self, namespace, document_id, text, vectors=None, metadata=None, graph=None):
        key = self._key(namespace, document_id)
        source_chunks = split_text(text)
        metadata = {} if metadata is None else metadata
        if not isinstance(metadata, dict):
            raise KnowledgeError("Document metadata must be an object")
        metadata_json = _json(metadata)
        if len(metadata_json.encode()) > 16 * 1024:
            raise KnowledgeError("Document metadata exceeds 16 KiB")
        graph = validate_graph(graph)
        embedding_id = "explicit:v1"
        if vectors is None and self.embedder is not None:
            vectors = self.embedder.embed_documents([chunk.text for chunk in source_chunks])
            embedding_id = self.embedder.identity
        if vectors is not None:
            if not isinstance(vectors, list) or len(vectors) != len(source_chunks):
                raise KnowledgeError("Provide one embedding vector for each text chunk")
            vectors = [validate_vector(vector) for vector in vectors]
            if len({len(vector) for vector in vectors}) != 1:
                raise KnowledgeError("Embedding vectors must use the same dimension")
        source_hash = sha256(text.encode()).hexdigest()
        content_hash = sha256(
            _json(
                {
                    "text": text,
                    "metadata": metadata,
                    "graph": graph,
                    "vectors": vectors,
                    "embedding_id": embedding_id,
                }
            ).encode()
        ).hexdigest()

        with self._lock, self.database.transaction() as session:
            document = session.scalar(select(Document).where(Document.key == key).with_for_update())
            if (
                document is not None
                and not document.deleted
                and document.content_hash == content_hash
            ):
                unchanged = True
                if (
                    graph is not None
                    and self.graph_store is not None
                    and document.graph_status == "not_configured"
                ):
                    document.graph_status = "pending"
                    self._job(session, document, "graph", "upsert", json.loads(document.graph_json))
            else:
                unchanged = False
                old_revision = document.revision if document is not None else None
                revision = 1 if old_revision is None else old_revision + 1
                if document is None:
                    document = Document(key=key, **namespace.payload(), document_id=document_id)
                    session.add(document)
                document.revision = revision
                document.content_hash = content_hash
                document.source_hash = source_hash
                document.text = text
                document.metadata_json = metadata_json
                document.deleted = False
                document.updated_at = _now()
                document.vector_status = "pending" if vectors is not None else "not_configured"
                document.graph_status = (
                    "pending" if graph is not None and self.graph_store else "not_configured"
                )
                # Insert the document before its foreign-key dependent chunks and jobs.
                session.flush()
                session.execute(delete(Chunk).where(Chunk.document_key == key))
                chunks = []
                for ordinal, chunk in enumerate(source_chunks):
                    chunk_id = str(uuid5(NAMESPACE_URL, f"cagent:{key}:{revision}:{ordinal}"))
                    session.add(
                        Chunk(
                            id=chunk_id,
                            document_key=key,
                            revision=revision,
                            ordinal=ordinal,
                            text=chunk.text,
                            start_offset=chunk.start_offset,
                            end_offset=chunk.end_offset,
                        )
                    )
                    chunks.append({"id": chunk_id, "ordinal": ordinal})
                if graph is not None:
                    available = {chunk["id"] for chunk in chunks}
                    for entity in graph["entities"]:
                        if entity["chunk_ids"] and not set(entity["chunk_ids"]) <= available:
                            raise KnowledgeError(
                                "Graph provenance must reference chunks in this document revision"
                            )
                        if not entity["chunk_ids"]:
                            entity["chunk_ids"] = [chunk["id"] for chunk in chunks]
                    document.graph_json = _json(graph)
                else:
                    document.graph_json = None
                if vectors is not None:
                    self._job(
                        session,
                        document,
                        "vector",
                        "upsert",
                        {
                            "chunks": chunks,
                            "vectors": vectors,
                            "embedding_id": embedding_id,
                        },
                    )
                if graph is not None and self.graph_store:
                    self._job(session, document, "graph", "upsert", graph)
                # Delete only a superseded version. A delayed cleanup must never delete a newer one.
                if old_revision is not None:
                    self._job(session, document, "vector", "delete", {}, old_revision)
                    if self.graph_store:
                        self._job(session, document, "graph", "delete", {}, old_revision)
            session.flush()
            accepted = self._record(session, document, unchanged=unchanged)
        self.process_pending(namespace, limit=100)
        record = self.get_document(namespace, document_id)
        if record is None or record.revision != accepted.revision:
            # A concurrent delete/update does not change the import acknowledgement's revision.
            return accepted
        record.unchanged = unchanged
        return record

    def get_document(self, namespace, document_id):
        key = self._key(namespace, document_id)
        with self.database.transaction() as session:
            document = session.scalar(
                select(Document).where(_scope(namespace), Document.key == key)
            )
            return None if document is None or document.deleted else self._record(session, document)

    def list_documents(self, namespace, limit=100):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise KnowledgeError("Document list limit must be between 1 and 100")
        with self.database.transaction() as session:
            rows = session.execute(
                select(Document, func.count(Chunk.id))
                .outerjoin(
                    Chunk,
                    and_(Chunk.document_key == Document.key, Chunk.revision == Document.revision),
                )
                .where(_scope(namespace), Document.deleted.is_(False))
                .group_by(Document.key)
                .order_by(Document.updated_at.desc(), Document.key)
                .limit(limit + 1)
            ).all()
            documents = []
            for document, chunk_count in rows[:limit]:
                title = json.loads(document.metadata_json).get("title")
                documents.append(
                    {
                        "document_id": document.document_id,
                        "title": title[:256]
                        if isinstance(title, str) and title
                        else document.document_id,
                        "revision": document.revision,
                        "chunk_count": chunk_count,
                        "vector_status": document.vector_status,
                        "graph_status": document.graph_status,
                        "updated_at": document.updated_at,
                    }
                )
            return {"documents": documents, "truncated": len(rows) > limit}

    def delete_document(self, namespace, document_id):
        key = self._key(namespace, document_id)
        with self._lock, self.database.transaction() as session:
            document = session.scalar(
                select(Document).where(_scope(namespace), Document.key == key).with_for_update()
            )
            if document is None or document.deleted:
                return DeleteResult(document_id, False)
            document.deleted = True
            document.text = ""
            document.metadata_json = "{}"
            document.graph_json = None
            document.updated_at = _now()
            document.vector_status = "pending"
            document.graph_status = "pending" if self.graph_store else "not_configured"
            session.execute(delete(Chunk).where(Chunk.document_key == key))
            self._job(session, document, "vector", "delete", {})
            if self.graph_store:
                self._job(session, document, "graph", "delete", {})
        self.process_pending(namespace)
        with self.database.transaction() as session:
            document = session.get(Document, key)
            return DeleteResult(document_id, True, document.vector_status, document.graph_status)

    def process_pending(self, namespace=None, limit=100):
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise KnowledgeError("Index batch limit must be between 1 and 1000")
        result = ProcessResult()
        cutoff = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
        with self.database.transaction() as session:
            query = (
                select(IndexJob.id)
                .join(Document, IndexJob.document_key == Document.key)
                .where(
                    or_(
                        IndexJob.status == "pending",
                        and_(IndexJob.status == "processing", IndexJob.claimed_at < cutoff),
                    )
                )
            )
            if namespace is not None:
                query = query.where(_scope(namespace))
            job_ids = session.scalars(
                query.order_by(IndexJob.created_at, IndexJob.id).limit(limit)
            ).all()
        for job_id in job_ids:
            token = str(uuid4())
            with self.database.transaction() as session:
                job = session.scalar(
                    select(IndexJob).where(IndexJob.id == job_id).with_for_update()
                )
                if job.status != "pending" and not (
                    job.status == "processing" and job.claimed_at < cutoff
                ):
                    continue
                document = session.get(Document, job.document_key)
                if job.action == "upsert" and (
                    document.deleted or document.revision != job.revision
                ):
                    # A worker may have written before crashing. Clean this exact stale version too.
                    job.action = "delete"
                    job.payload_json = "{}"
                    result.superseded += 1
                store = self.vector_store if job.target == "vector" else self.graph_store
                if store is None:
                    continue
                job.status = "processing"
                job.claim_token = token
                job.claimed_at = _now()
                job.attempts += 1
                job_namespace = Namespace(document.tenant_id, document.agent_id, document.space_id)
                key, revision, target, action = (
                    job.document_key,
                    job.revision,
                    job.target,
                    job.action,
                )
                document_id = document.document_id
                payload = json.loads(job.payload_json)
            try:
                if action == "delete":
                    store.delete(job_namespace, key, revision)
                elif target == "vector":
                    store.upsert(
                        job_namespace,
                        key,
                        document_id,
                        revision,
                        payload["chunks"],
                        payload["vectors"],
                        payload["embedding_id"],
                    )
                else:
                    store.upsert(job_namespace, key, document_id, revision, payload)
            except Exception:
                # Deliberately store only a public category, never provider exception strings.
                with self.database.transaction() as session:
                    job = session.get(IndexJob, job_id)
                    if job.claim_token == token:
                        job.status = "pending"
                        job.last_error = "INDEX_UNAVAILABLE"
                        job.claim_token = None
                result.failed += 1
                continue
            with self.database.transaction() as session:
                job = session.get(IndexJob, job_id)
                if job.claim_token != token:
                    continue
                document = session.get(Document, key)
                if action == "upsert" and (document.deleted or document.revision != revision):
                    job.action = "delete"
                    job.payload_json = "{}"
                    job.status = "pending"
                else:
                    job.status = "done"
                    job.payload_json = "{}"
                    if document.revision == revision:
                        value = "deleted" if document.deleted else "indexed"
                        if target == "vector":
                            document.vector_status = value
                        else:
                            document.graph_status = value
                job.last_error = None
                job.claim_token = None
                result.processed += 1
        return result

    def search(self, namespace, query_text=None, query_vector=None, limit=10):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise KnowledgeError("Search limit must be between 1 and 100")
        embedding_id = "explicit:v1"
        if query_text is not None:
            if not isinstance(query_text, str) or not query_text.strip() or len(query_text) > 4096:
                raise KnowledgeError("Search text must contain 1 to 4096 characters")
        if query_vector is None and query_text is not None and self.embedder is not None:
            query_vector = self.embedder.embed_query(query_text)
            embedding_id = self.embedder.identity
        if query_vector is None:
            if query_text is None:
                raise KnowledgeError("Provide search text or a query embedding")
            return self._lexical_search(namespace, query_text, limit)
        query_vector = validate_vector(query_vector)
        try:
            points = self.vector_store.search(
                namespace, query_vector, min(limit * 8, 800), embedding_id
            )
        except Exception as error:
            raise KnowledgeError(
                "Vector index is unavailable", "VECTOR_INDEX_UNAVAILABLE"
            ) from error
        hits = []
        with self.database.transaction() as session:
            for chunk_id, payload, score in points:
                if any(payload.get(key) != value for key, value in namespace.payload().items()):
                    continue
                chunk = session.get(Chunk, chunk_id)
                if chunk is None:
                    continue
                document = session.get(Document, chunk.document_key)
                if (
                    document.deleted
                    or document.revision != payload.get("revision")
                    or document.revision != chunk.revision
                    or document.key != payload.get("document_key")
                    or document.vector_status != "indexed"
                ):
                    continue
                if (document.tenant_id, document.agent_id, document.space_id) != (
                    namespace.tenant_id,
                    namespace.agent_id,
                    namespace.space_id,
                ):
                    continue
                hits.append(self._hit(document, chunk, score))
                if len(hits) == limit:
                    break
        return SearchResult("vector", hits, len(points) == min(limit * 8, 800))

    @staticmethod
    def _hit(document, chunk, score):
        return SearchHit(
            document.document_id,
            chunk.id,
            chunk.revision,
            chunk.text,
            chunk.start_offset,
            chunk.end_offset,
            score,
            json.loads(document.metadata_json),
        )

    def _lexical_search(self, namespace, query, limit):
        # Escaped SQL LIKE narrows candidates. Python confirms literal Unicode matching.
        escaped = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        hits = []
        with self.database.transaction() as session:
            rows = session.execute(
                select(Chunk, Document)
                .join(Document, Chunk.document_key == Document.key)
                .where(
                    _scope(namespace),
                    Document.deleted.is_(False),
                    Chunk.revision == Document.revision,
                    Chunk.text.ilike(f"%{escaped}%", escape="\\"),
                )
                .order_by(Document.updated_at.desc(), Document.key, Chunk.ordinal)
                .limit(1001)
            ).all()
            for chunk, document in rows[:1000]:
                count = chunk.text.casefold().count(query.strip().casefold())
                if count:
                    hits.append(self._hit(document, chunk, float(count)))
            hits.sort(key=lambda hit: (-hit.score, hit.document_id, hit.start_offset))
        return SearchResult("lexical", hits[:limit], len(rows) > 1000)

    def graph_neighbors(self, namespace, entity_id, limit=20):
        if self.graph_store is None:
            raise KnowledgeError("Neo4j is not configured", "GRAPH_NOT_CONFIGURED")
        with self.database.transaction() as session:
            documents = session.scalars(
                select(Document)
                .where(
                    _scope(namespace),
                    Document.deleted.is_(False),
                    Document.graph_status == "indexed",
                )
                .limit(1001)
            ).all()
            if len(documents) > 1000:
                raise KnowledgeError(
                    "Graph query exceeds 1000 active documents; narrow the knowledge space"
                )
            versions = [f"{document.key}:{document.revision}" for document in documents]
        try:
            return self.graph_store.neighbors(
                namespace, entity_id, document_versions=versions, limit=limit
            )
        except KnowledgeError:
            raise
        except Exception as error:
            raise KnowledgeError("Graph index is unavailable", "GRAPH_INDEX_UNAVAILABLE") from error

    def health(self):
        return {
            "storage": {
                "enabled": True,
                "available": True,
                "dialect": self.database.url.get_backend_name(),
            },
            "vector": self.vector_store.health(),
            "graph": self.graph_store.health()
            if self.graph_store
            else {"enabled": False, "available": False},
            "embedding": {"enabled": self.embedder is not None},
        }

    def close(self):
        self.vector_store.close()
        if self.graph_store is not None:
            self.graph_store.close()
