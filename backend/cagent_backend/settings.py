"""Validated loopback configuration; launch credentials are delivered on stdin."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


def loopback_origin(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("A fixed http://127.0.0.1:port origin is required")
    if not 1 <= parsed.port <= 65535:
        raise ValueError("Invalid loopback port")
    return f"http://127.0.0.1:{parsed.port}"


class Settings(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    home: Path
    upstream_origin: str = Field(alias="upstreamOrigin")
    internal_token: SecretStr = Field(alias="internalToken", min_length=24, max_length=256)
    public_token: SecretStr = Field(alias="publicToken", min_length=24, max_length=256)
    ui_dir: Path | None = Field(default=None, alias="uiDir")
    gateway_origin: str | None = None
    database_url: str | None = None
    qdrant_url: str | None = None
    qdrant_api_key: SecretStr | None = None
    neo4j_uri: str | None = None
    neo4j_username: str = "neo4j"
    neo4j_password: SecretStr | None = None
    neo4j_database: str = "neo4j"
    embedding_url: str | None = None
    embedding_model: str | None = None
    embedding_key: SecretStr | None = None

    @field_validator("upstream_origin", "gateway_origin")
    @classmethod
    def validate_origin(cls, value: str | None) -> str | None:
        return loopback_origin(value) if value is not None else None

    @field_validator("home", "ui_dir")
    @classmethod
    def resolve_paths(cls, value: Path | None) -> Path | None:
        return value.resolve() if value is not None else None

    @classmethod
    def from_launch(cls, config: dict) -> Settings:
        """Optional services are explicit, and desktop SQLite needs no server."""
        overrides = {
            "database_url": os.environ.get("CAGENT_DATABASE_URL"),
            "qdrant_url": os.environ.get("CAGENT_QDRANT_URL"),
            "qdrant_api_key": os.environ.get("CAGENT_QDRANT_API_KEY"),
            "neo4j_uri": os.environ.get("CAGENT_NEO4J_URI"),
            "neo4j_password": os.environ.get("CAGENT_NEO4J_PASSWORD"),
            "embedding_url": os.environ.get("CAGENT_EMBEDDING_URL"),
            "embedding_model": os.environ.get("CAGENT_EMBEDDING_MODEL"),
            "embedding_key": os.environ.get("CAGENT_EMBEDDING_KEY"),
        }
        for field, variable in (
            ("neo4j_username", "CAGENT_NEO4J_USERNAME"),
            ("neo4j_database", "CAGENT_NEO4J_DATABASE"),
        ):
            if os.environ.get(variable):
                overrides[field] = os.environ[variable]
        return cls.model_validate({**config, **{k: v for k, v in overrides.items() if v}})

    def service_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return "sqlite:///" + (self.home / "backend" / "application.sqlite").as_posix()
