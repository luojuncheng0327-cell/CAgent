from hashlib import sha256
from threading import RLock

from .types import KnowledgeError, validate_identity


def validate_graph(graph: dict | None) -> dict | None:
    if graph is None:
        return None
    if not isinstance(graph, dict) or set(graph) - {"entities", "relations"}:
        raise KnowledgeError("Graph must contain only entities and relations")
    entities = graph.get("entities", [])
    relations = graph.get("relations", [])
    if not isinstance(entities, list) or not isinstance(relations, list):
        raise KnowledgeError("Graph entities and relations must be lists")
    if len(entities) > 128 or len(relations) > 128:
        raise KnowledgeError("Graph import is limited to 128 entities and 128 relations")
    normalized = {"entities": [], "relations": []}
    entity_ids = set()
    for entity in entities:
        if not isinstance(entity, dict) or set(entity) - {"id", "name", "kind", "chunk_ids"}:
            raise KnowledgeError("Invalid graph entity")
        entity_id = validate_identity(entity.get("id"), "entity id")
        if entity_id in entity_ids:
            raise KnowledgeError("Graph entity identifiers must be unique")
        entity_ids.add(entity_id)
        chunk_ids = entity.get("chunk_ids", [])
        if not isinstance(chunk_ids, list) or len(chunk_ids) > 600:
            raise KnowledgeError("Invalid graph entity provenance")
        normalized["entities"].append(
            {
                "id": entity_id,
                "name": validate_identity(entity.get("name"), "entity name", 256),
                "kind": validate_identity(entity.get("kind", "Entity"), "entity kind", 64),
                "chunk_ids": [validate_identity(item, "chunk id", 36) for item in chunk_ids],
            }
        )
    for relation in relations:
        if not isinstance(relation, dict) or set(relation) - {"source", "target", "type"}:
            raise KnowledgeError("Invalid graph relation")
        if relation.get("source") not in entity_ids or relation.get("target") not in entity_ids:
            raise KnowledgeError("Graph relations must reference entities in this document")
        normalized["relations"].append(
            {
                "source": relation["source"],
                "target": relation["target"],
                "type": validate_identity(relation.get("type"), "relation type", 64),
            }
        )
    return normalized


class Neo4jGraphStore:
    """Bounded fixed Cypher operations. The caller cannot supply arbitrary Cypher."""

    def __init__(self, uri, username, password, database="neo4j", *, driver=None):
        self.uri = uri
        self.username = username
        self.password = password
        self.database = database
        self._driver = driver
        self._lock = RLock()

    @property
    def driver(self):
        with self._lock:
            if self._driver is None:
                from neo4j import GraphDatabase

                self._driver = GraphDatabase.driver(
                    self.uri,
                    auth=(self.username, self.password),
                    connection_timeout=5,
                    connection_acquisition_timeout=5,
                    max_transaction_retry_time=5,
                )
            return self._driver

    @staticmethod
    def _entity_key(document_key, revision, entity_id):
        return sha256(f"{document_key}:{revision}:{entity_id}".encode()).hexdigest()

    def upsert(self, namespace, document_key, document_id, revision, graph):
        graph = validate_graph(graph)
        entities = [
            {**item, "key": self._entity_key(document_key, revision, item["id"])}
            for item in graph["entities"]
        ]
        relations = [
            {
                "source_key": self._entity_key(document_key, revision, item["source"]),
                "target_key": self._entity_key(document_key, revision, item["target"]),
                "type": item["type"],
            }
            for item in graph["relations"]
        ]
        params = {
            **namespace.payload(),
            "document_key": document_key,
            "document_id": document_id,
            "revision": revision,
            "document_version": f"{document_key}:{revision}",
            "entities": entities,
            "relations": relations,
        }

        def write(transaction):
            transaction.run(
                """MATCH (e:CAgentKnowledgeEntity {tenant_id:$tenant_id, agent_id:$agent_id,
                space_id:$space_id, document_version:$document_version}) DETACH DELETE e""",
                **params,
            ).consume()
            transaction.run(
                """UNWIND $entities AS entity
                MERGE (e:CAgentKnowledgeEntity {key:entity.key})
                SET e.tenant_id=$tenant_id, e.agent_id=$agent_id, e.space_id=$space_id,
                    e.document_key=$document_key, e.document_id=$document_id,
                    e.revision=$revision, e.document_version=$document_version,
                    e.entity_id=entity.id, e.name=entity.name, e.kind=entity.kind,
                    e.chunk_ids=entity.chunk_ids""",
                **params,
            ).consume()
            transaction.run(
                """UNWIND $relations AS relation
                MATCH (source:CAgentKnowledgeEntity {key:relation.source_key}),
                      (target:CAgentKnowledgeEntity {key:relation.target_key})
                MERGE (source)-[r:CAGENT_RELATION {type:relation.type}]->(target)
                SET r.document_version=$document_version""",
                **params,
            ).consume()

        with self.driver.session(database=self.database) as session:
            session.execute_write(write)

    def delete(self, namespace, document_key, revision=None):
        params = {**namespace.payload(), "document_key": document_key, "revision": revision}
        query = """MATCH (e:CAgentKnowledgeEntity {tenant_id:$tenant_id, agent_id:$agent_id,
                   space_id:$space_id, document_key:$document_key})
                   WHERE $revision IS NULL OR e.revision=$revision DETACH DELETE e"""
        with self.driver.session(database=self.database) as session:
            session.execute_write(lambda transaction: transaction.run(query, **params).consume())

    def neighbors(self, namespace, entity_id, *, document_versions, limit=20):
        validate_identity(entity_id, "entity id")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise KnowledgeError("Graph query limit must be between 1 and 100")
        if not isinstance(document_versions, list) or len(document_versions) > 1000:
            raise KnowledgeError("Invalid active document versions")
        if not document_versions:
            return []
        params = {
            **namespace.payload(),
            "entity_id": entity_id,
            "document_versions": document_versions,
            "limit": limit,
        }
        query = """MATCH (e:CAgentKnowledgeEntity {tenant_id:$tenant_id, agent_id:$agent_id,
                  space_id:$space_id, entity_id:$entity_id})-[r:CAGENT_RELATION]-(other)
                  WHERE e.document_version IN $document_versions
                  AND other.document_version IN $document_versions
                  AND other.tenant_id=$tenant_id AND other.agent_id=$agent_id
                  AND other.space_id=$space_id
                  RETURN e.entity_id AS source, other.entity_id AS target,
                    other.name AS name, other.kind AS kind, r.type AS relation,
                    e.document_id AS document_id, e.revision AS revision,
                    e.chunk_ids AS source_chunk_ids, other.chunk_ids AS target_chunk_ids
                  ORDER BY document_id, source, target LIMIT $limit"""
        with self.driver.session(database=self.database) as session:
            return session.execute_read(lambda transaction: transaction.run(query, **params).data())

    def health(self):
        try:
            self.driver.verify_connectivity()
            return {"enabled": True, "available": True}
        except Exception:
            return {"enabled": True, "available": False}

    def close(self):
        with self._lock:
            if self._driver is not None:
                self._driver.close()
                self._driver = None
