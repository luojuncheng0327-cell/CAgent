"""Source-backed retrieval and optional vector/graph adapters."""

from .embeddings import OpenAICompatibleEmbedder
from .graph import Neo4jGraphStore
from .service import KnowledgeService
from .types import KnowledgeError, Namespace, split_text
from .vector import QdrantVectorStore

__all__ = [
    "KnowledgeError",
    "KnowledgeService",
    "Namespace",
    "Neo4jGraphStore",
    "OpenAICompatibleEmbedder",
    "QdrantVectorStore",
    "split_text",
]
