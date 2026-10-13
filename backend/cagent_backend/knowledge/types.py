from dataclasses import dataclass, field
from math import isfinite


class KnowledgeError(ValueError):
    """Safe public error: provider credentials and connection details never escape."""

    def __init__(self, message: str, code: str = "INVALID_KNOWLEDGE_INPUT"):
        super().__init__(message)
        self.code = code


def validate_identity(value: str, name: str, maximum: int = 128) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise KnowledgeError(f"{name} must be a nonempty string of at most {maximum} characters")
    if any(ord(character) < 32 for character in value):
        raise KnowledgeError(f"{name} must not contain control characters")
    return value


@dataclass(frozen=True)
class Namespace:
    tenant_id: str
    agent_id: str
    space_id: str

    def __post_init__(self):
        validate_identity(self.tenant_id, "tenant_id")
        validate_identity(self.agent_id, "agent_id", 150)
        validate_identity(self.space_id, "space_id")

    def payload(self) -> dict[str, str]:
        return {"tenant_id": self.tenant_id, "agent_id": self.agent_id, "space_id": self.space_id}


@dataclass(frozen=True)
class TextChunk:
    text: str
    start_offset: int
    end_offset: int


def split_text(text: str, chunk_size: int = 1024, overlap: int = 128) -> list[TextChunk]:
    if not isinstance(text, str) or not text.strip():
        raise KnowledgeError("Document text must not be empty")
    if len(text.encode("utf-8")) > 512 * 1024:
        raise KnowledgeError("Document text exceeds the 512 KiB limit")
    if chunk_size < 64 or chunk_size > 4096 or overlap < 0 or overlap >= chunk_size:
        raise KnowledgeError("Invalid chunk size or overlap")
    chunks = []
    for start in range(0, len(text), chunk_size - overlap):
        end = min(start + chunk_size, len(text))
        chunks.append(TextChunk(text[start:end], start, end))
        if end == len(text):
            break
    return chunks


def validate_vector(vector) -> list[float]:
    if not isinstance(vector, (list, tuple)) or not 1 <= len(vector) <= 4096:
        raise KnowledgeError("Each embedding vector must contain 1 to 4096 numbers")
    if any(type(value) not in (int, float) or not isfinite(value) for value in vector):
        raise KnowledgeError("Embedding vectors must contain finite numbers")
    if not any(value != 0 for value in vector):
        raise KnowledgeError("Embedding vectors must not be all zero")
    return [float(value) for value in vector]


@dataclass
class DocumentRecord:
    document_id: str
    revision: int
    source_hash: str
    text: str
    metadata: dict
    chunk_count: int
    vector_status: str
    graph_status: str
    unchanged: bool = False


@dataclass
class SearchHit:
    document_id: str
    chunk_id: str
    revision: int
    text: str
    start_offset: int
    end_offset: int
    score: float
    metadata: dict = field(default_factory=dict)


@dataclass
class SearchResult:
    method: str
    hits: list[SearchHit]
    truncated: bool = False


@dataclass
class DeleteResult:
    document_id: str
    deleted: bool
    vector_status: str = "not_configured"
    graph_status: str = "not_configured"


@dataclass
class ProcessResult:
    processed: int = 0
    failed: int = 0
    superseded: int = 0
