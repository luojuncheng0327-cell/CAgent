# 可选服务模式

普通桌面启动使用独立的后端 SQLite 数据库与本地持久化 Qdrant，不需要 Docker、Redis、PostgreSQL 或 Neo4j。旧 `cagent.sqlite` 仍由兼容服务管理，新的 SQLAlchemy 表不在其中创建，也不自动复制原来的真实数据。

`compose.yaml` 只提供可选数据库服务，端口全部绑定 `127.0.0.1`。复制 `.env.example` 到本目录的 `.env` 后设置不同的随机密码；本机 `.env` 不应进入 Git。密码放入连接 URL 时需 URL 编码。

```powershell
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
# 需要关系图谱时显式启用 graph profile
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile graph up -d
```

向后端进程显式提供 `CAGENT_DATABASE_URL`、`CAGENT_QDRANT_URL` 和相应密钥。只有配置 `CAGENT_NEO4J_URI` 才创建 Neo4j 适配器；实例不可用时不会阻止桌面启动，知识内容先保存，图谱索引任务保留待重试。图谱接口只接受有来源的实体与关系，不能执行调用者传入的 Cypher。

嵌入模型不会自动下载或付费调用。默认文本导入可使用真实的关键词检索；要启用语义检索，可以在导入时提供每个分块的向量，或者显式配置 `CAGENT_EMBEDDING_URL`、`CAGENT_EMBEDDING_MODEL` 和 `CAGENT_EMBEDDING_KEY`，由 `OpenAICompatibleEmbedder` 使用 LangChain 嵌入接口。三个配置齐全才启用；无需鉴权的本地接口可配置其允许的占位 Key。URL 为 OpenAI 兼容接口基础地址。检索结果带文档、版本、分块与字符偏移来源。

文档与索引任务在同一 SQL 事务中提交，Qdrant 和 Neo4j 通过版本化 outbox 写入。不同数据库之间没有跨库事务保证。检索会再检查 SQL 的当前版本和删除状态，尚未完成索引或过期的候选不会返回。失败的任务可通过 API 主动重试，或者由下述可选 Celery 任务处理。

## Celery 索引 worker

在 `backend` 安装 `worker` 与 `postgres` extra，并设置 `CAGENT_DATABASE_URL`、远端 `CAGENT_QDRANT_URL`、`CAGENT_REDIS_URL` 和对应服务密钥。Worker 明确拒绝默认个人数据目录和本地 Qdrant 路径，避免多个进程争用本地索引。Windows 使用 solo pool：

```powershell
python -m celery -A cagent_backend.knowledge.jobs:app worker --pool=solo --loglevel=INFO
python -m celery -A cagent_backend.knowledge.jobs:app call cagent.knowledge.process_pending
```

每次任务最多处理 100 项；失败最多重试 3 次，源文档和未完成任务保留。任务消息不携带密码或文档内容，连接设置来自 worker 环境变量。桌面默认无需导入 Celery 或连接 Redis。

这份配置未在本轮拉取镜像或启动容器。PostgreSQL、Redis、远端 Qdrant 和真实 Neo4j 的服务联调仍需单独验收；已执行的自动化使用临时 SQLite、真实本地 Qdrant 及 Neo4j 参数调用替身。
