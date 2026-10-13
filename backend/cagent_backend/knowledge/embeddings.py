from hashlib import sha256
from urllib.parse import urlparse

from .types import KnowledgeError, validate_identity


class OpenAICompatibleEmbedder:
    """Opt-in LangChain embedding bridge; constructing it makes no network calls."""

    def __init__(self, base_url, model, api_key, *, dimensions=None):
        parsed = urlparse(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise KnowledgeError("Configure a valid embedding service URL")
        if parsed.username or parsed.password:
            raise KnowledgeError("Embedding service URL must not contain credentials")
        validate_identity(model, "embedding model", 256)
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.dimensions = dimensions
        self.identity = (
            "openai-compatible:"
            + sha256(f"{self.base_url}|{model}|{dimensions}".encode()).hexdigest()
        )
        self._bridge = None

    @property
    def bridge(self):
        if self._bridge is None:
            from langchain_openai import OpenAIEmbeddings

            kwargs = {
                "base_url": self.base_url,
                "model": self.model,
                "api_key": self.api_key,
                "request_timeout": 15,
                "max_retries": 0,
                "check_embedding_ctx_length": False,
            }
            if self.dimensions is not None:
                kwargs["dimensions"] = self.dimensions
            self._bridge = OpenAIEmbeddings(**kwargs)
        return self._bridge

    def embed_documents(self, texts):
        try:
            return self.bridge.embed_documents(texts)
        except Exception as error:
            raise KnowledgeError(
                "Embedding service is unavailable", "EMBEDDINGS_UNAVAILABLE"
            ) from error

    def embed_query(self, text):
        try:
            return self.bridge.embed_query(text)
        except Exception as error:
            raise KnowledgeError(
                "Embedding service is unavailable", "EMBEDDINGS_UNAVAILABLE"
            ) from error
