from hashlib import sha256
from pathlib import Path
from threading import RLock

from .types import Namespace, validate_vector


class QdrantVectorStore:
    """Official Qdrant client, local persistent storage or an explicitly configured URL."""

    def __init__(self, *, path: str | Path | None = None, url=None, api_key=None):
        if not url and path is None:
            raise ValueError("Configure a local Qdrant path or a remote Qdrant URL")
        if url and path is not None:
            raise ValueError("Configure either local Qdrant storage or a remote URL")
        self.path = Path(path) if path is not None else None
        self.url = url
        self.api_key = api_key
        self._client = None
        self._lock = RLock()

    @property
    def client(self):
        with self._lock:
            if self._client is None:
                from qdrant_client import QdrantClient

                if self.url:
                    self._client = QdrantClient(url=self.url, api_key=self.api_key, timeout=5)
                else:
                    self.path.mkdir(parents=True, exist_ok=True)
                    self._client = QdrantClient(path=str(self.path))
            return self._client

    @staticmethod
    def collection_name(dimensions: int, embedding_id: str) -> str:
        digest = sha256(embedding_id.encode("utf-8")).hexdigest()[:16]
        return f"cagent_knowledge_v1_{dimensions}_{digest}"

    @staticmethod
    def _filter(namespace: Namespace, document_key=None, revision=None):
        from qdrant_client import models

        fields: dict = namespace.payload()
        if document_key is not None:
            fields["document_key"] = document_key
        if revision is not None:
            fields["revision"] = revision
        return models.Filter(
            must=[
                models.FieldCondition(key=key, match=models.MatchValue(value=value))
                for key, value in fields.items()
            ]
        )

    def upsert(self, namespace, document_key, document_id, revision, chunks, vectors, embedding_id):
        from qdrant_client import models

        with self._lock:
            dimensions = len(vectors[0])
            name = self.collection_name(dimensions, embedding_id)
            if not self.client.collection_exists(name):
                self.client.create_collection(
                    name,
                    vectors_config=models.VectorParams(
                        size=dimensions, distance=models.Distance.COSINE
                    ),
                )
            self.client.upsert(
                name,
                points=[
                    models.PointStruct(
                        id=chunk["id"],
                        vector=vector,
                        payload={
                            **namespace.payload(),
                            "document_key": document_key,
                            "document_id": document_id,
                            "revision": revision,
                            "ordinal": chunk["ordinal"],
                            "embedding_id": embedding_id,
                        },
                    )
                    for chunk, vector in zip(chunks, vectors, strict=True)
                ],
                wait=True,
            )

    def search(self, namespace, query_vector, limit=10, embedding_id="explicit:v1"):
        vector = validate_vector(query_vector)
        with self._lock:
            name = self.collection_name(len(vector), embedding_id)
            if not self.client.collection_exists(name):
                return []
            result = self.client.query_points(
                name,
                query=vector,
                query_filter=self._filter(namespace),
                limit=limit,
                with_payload=True,
                with_vectors=False,
            )
            return [
                (str(point.id), point.payload or {}, float(point.score)) for point in result.points
            ]

    def delete(self, namespace, document_key, revision=None):
        from qdrant_client import models

        with self._lock:
            for collection in self.client.get_collections().collections:
                if collection.name.startswith("cagent_knowledge_v1_"):
                    self.client.delete(
                        collection.name,
                        points_selector=models.FilterSelector(
                            filter=self._filter(namespace, document_key, revision)
                        ),
                        wait=True,
                    )

    def health(self):
        try:
            with self._lock:
                self.client.get_collections()
            return {"enabled": True, "available": True, "mode": "remote" if self.url else "local"}
        except Exception:
            return {"enabled": True, "available": False, "mode": "remote" if self.url else "local"}

    def close(self):
        with self._lock:
            if self._client is not None:
                self._client.close()
                self._client = None
