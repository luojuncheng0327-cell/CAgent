from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Document(Base):
    __tablename__ = "knowledge_documents"
    __table_args__ = (
        Index("ix_knowledge_documents_namespace", "tenant_id", "agent_id", "space_id"),
    )

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(128))
    agent_id: Mapped[str] = mapped_column(String(150))
    space_id: Mapped[str] = mapped_column(String(128))
    document_id: Mapped[str] = mapped_column(String(256))
    revision: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64))
    source_hash: Mapped[str] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)
    metadata_json: Mapped[str] = mapped_column(Text)
    graph_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    vector_status: Mapped[str] = mapped_column(String(24))
    graph_status: Mapped[str] = mapped_column(String(24))
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[str] = mapped_column(String(40))


class Chunk(Base):
    __tablename__ = "knowledge_chunks"
    __table_args__ = (Index("ix_knowledge_chunks_document", "document_key", "revision"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_key: Mapped[str] = mapped_column(
        String(64), ForeignKey("knowledge_documents.key", ondelete="CASCADE")
    )
    revision: Mapped[int] = mapped_column(Integer)
    ordinal: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    start_offset: Mapped[int] = mapped_column(Integer)
    end_offset: Mapped[int] = mapped_column(Integer)


class IndexJob(Base):
    __tablename__ = "knowledge_index_jobs"
    __table_args__ = (
        Index("ix_knowledge_jobs_pending", "status", "created_at"),
        Index("ix_knowledge_jobs_document", "document_key", "revision", "target"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    document_key: Mapped[str] = mapped_column(
        String(64), ForeignKey("knowledge_documents.key", ondelete="CASCADE")
    )
    revision: Mapped[int] = mapped_column(Integer)
    target: Mapped[str] = mapped_column(String(12))
    action: Mapped[str] = mapped_column(String(12))
    payload_json: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(String(80), nullable=True)
    claim_token: Mapped[str | None] = mapped_column(String(36), nullable=True)
    claimed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[str] = mapped_column(String(40))
