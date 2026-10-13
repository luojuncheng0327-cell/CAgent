"""Knowledge source of truth and retryable index outbox."""

import sqlalchemy as sa

from alembic import op

revision = "0001_knowledge"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "knowledge_documents",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("tenant_id", sa.String(128), nullable=False),
        sa.Column("agent_id", sa.String(150), nullable=False),
        sa.Column("space_id", sa.String(128), nullable=False),
        sa.Column("document_id", sa.String(256), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("source_hash", sa.String(64), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("metadata_json", sa.Text(), nullable=False),
        sa.Column("graph_json", sa.Text(), nullable=True),
        sa.Column("vector_status", sa.String(24), nullable=False),
        sa.Column("graph_status", sa.String(24), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.String(40), nullable=False),
    )
    op.create_index(
        "ix_knowledge_documents_namespace",
        "knowledge_documents",
        ["tenant_id", "agent_id", "space_id"],
    )
    op.create_table(
        "knowledge_chunks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "document_key",
            sa.String(64),
            sa.ForeignKey("knowledge_documents.key", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
    )
    op.create_index(
        "ix_knowledge_chunks_document", "knowledge_chunks", ["document_key", "revision"]
    )
    op.create_table(
        "knowledge_index_jobs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "document_key",
            sa.String(64),
            sa.ForeignKey("knowledge_documents.key", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("target", sa.String(12), nullable=False),
        sa.Column("action", sa.String(12), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("last_error", sa.String(80), nullable=True),
        sa.Column("claim_token", sa.String(36), nullable=True),
        sa.Column("claimed_at", sa.String(40), nullable=True),
        sa.Column("created_at", sa.String(40), nullable=False),
    )
    op.create_index("ix_knowledge_jobs_pending", "knowledge_index_jobs", ["status", "created_at"])
    op.create_index(
        "ix_knowledge_jobs_document", "knowledge_index_jobs", ["document_key", "revision", "target"]
    )


def downgrade():
    op.drop_table("knowledge_index_jobs")
    op.drop_table("knowledge_chunks")
    op.drop_table("knowledge_documents")
