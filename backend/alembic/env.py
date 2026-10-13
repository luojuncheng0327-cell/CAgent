from alembic import context
from cagent_backend.storage.models import Base

config = context.config
connection = config.attributes.get("connection")
if connection is None:
    raise RuntimeError("Run migrations through Database.migrate() with an explicit database URL")

context.configure(
    connection=connection,
    target_metadata=Base.metadata,
    compare_type=True,
    transactional_ddl=True,
)
with context.begin_transaction():
    context.run_migrations()
