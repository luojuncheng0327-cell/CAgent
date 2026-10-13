"""Server worker factory; desktop/API callers may construct KnowledgeService directly."""

import os

from cagent_backend.storage import Database

from .graph import Neo4jGraphStore
from .service import KnowledgeService
from .vector import QdrantVectorStore


def build_service():
    # The worker never guesses a real user home and must not open local Qdrant concurrently.
    database_url = os.environ.get("CAGENT_DATABASE_URL")
    qdrant_url = os.environ.get("CAGENT_QDRANT_URL")
    if not database_url or not qdrant_url:
        raise RuntimeError("Server worker requires CAGENT_DATABASE_URL and CAGENT_QDRANT_URL")
    database = Database(database_url)
    database.migrate()
    vector = QdrantVectorStore(
        url=qdrant_url,
        api_key=os.environ.get("CAGENT_QDRANT_API_KEY"),
    )
    graph = None
    if os.environ.get("CAGENT_NEO4J_URI"):
        graph = Neo4jGraphStore(
            os.environ["CAGENT_NEO4J_URI"],
            os.environ.get("CAGENT_NEO4J_USERNAME", "neo4j"),
            os.environ.get("CAGENT_NEO4J_PASSWORD", ""),
            os.environ.get("CAGENT_NEO4J_DATABASE", "neo4j"),
        )
    return KnowledgeService(database, vector, graph)
