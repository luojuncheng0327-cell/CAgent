"""FastAPI owns the public boundary and the LangGraph execution service."""

from __future__ import annotations

import asyncio
import hmac
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict, is_dataclass
from typing import Any
from urllib.parse import quote, unquote, urlsplit

import httpx
from anyio import CancelScope
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from cagent_backend.settings import Settings

MAX_REQUEST_BYTES = 48 * 1024 * 1024
HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def error_response(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


def safe_headers(headers: httpx.Headers | Any, *, request: bool) -> list[tuple[str, str]]:
    excluded = HOP_HEADERS | {"content-length"}
    excluded.update(part.strip().lower() for part in headers.get("connection", "").split(","))
    if request:
        excluded |= {"host", "origin", "forwarded", "accept-encoding", "expect"}
    else:
        # httpx iter_bytes transparently decodes the upstream body.
        excluded |= {"content-encoding"}
    items = headers.multi_items() if hasattr(headers, "multi_items") else headers.items()
    return [
        (name, value)
        for name, value in items
        if name.lower() not in excluded
        and not (request and name.lower().startswith("x-forwarded-"))
    ]


class BoundaryMiddleware:
    """Validate the real socket origin and bound bodies before forwarding effects."""

    def __init__(self, app: ASGIApp, settings: Settings):
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = [(key.lower(), value) for key, value in scope["headers"]]
        hosts = [value.decode("latin-1") for key, value in headers if key == b"host"]
        origins = [value.decode("latin-1") for key, value in headers if key == b"origin"]
        expected_origin = self.settings.gateway_origin
        if expected_origin is None:
            server = scope.get("server")
            expected_origin = f"http://127.0.0.1:{server[1]}" if server else ""
        expected_host = urlsplit(expected_origin).netloc
        if len(hosts) != 1 or hosts[0] != expected_host:
            await error_response("INVALID_HOST", "访问来源不匹配", 403)(scope, receive, send)
            return
        if origins and (len(origins) != 1 or origins[0] != expected_origin):
            await error_response("INVALID_ORIGIN", "跨来源请求已拒绝", 403)(scope, receive, send)
            return
        lengths = [value for key, value in headers if key == b"content-length"]
        if lengths:
            try:
                length = int(lengths[0])
                if len(lengths) != 1 or length < 0:
                    raise ValueError
            except ValueError:
                await error_response("INVALID_BODY", "请求长度无效", 400)(scope, receive, send)
                return
            if length > MAX_REQUEST_BYTES:
                await error_response("BODY_TOO_LARGE", "请求超过大小上限", 413)(
                    scope, receive, send
                )
                return
        # A bounded preflight avoids sending a partial write to the compatibility worker.
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            body.extend(message.get("body", b""))
            if len(body) > MAX_REQUEST_BYTES:
                await error_response("BODY_TOO_LARGE", "请求超过大小上限", 413)(
                    scope, receive, send
                )
                return
            if not message.get("more_body", False):
                break
        scope["cagent.gateway_origin"] = expected_origin
        body_message_sent = False

        async def replay() -> Message:
            nonlocal body_message_sent
            if not body_message_sent:
                body_message_sent = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        async def secure_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers", []))
                existing = {name.lower() for name, _ in message["headers"]}
                for name, value in (
                    (b"x-content-type-options", b"nosniff"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"x-frame-options", b"DENY"),
                ):
                    if name not in existing:
                        message["headers"].append((name, value))
            await send(message)

        await self.app(scope, replay, secure_send)


class GraphRunInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runId: str = Field(min_length=1, max_length=150)
    maxToolRounds: int = Field(default=12, ge=1, le=32)
    purpose: str = Field(default="chat", pattern=r"^(chat|compact)$")


class DocumentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    documentId: str = Field(min_length=1, max_length=150)
    text: str = Field(min_length=1, max_length=512 * 1024)
    vectors: list[list[float]] | None = None
    metadata: dict[str, Any] | None = None
    graph: dict[str, Any] | None = None


class SearchInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    queryText: str | None = Field(default=None, min_length=1, max_length=4096)
    queryVector: list[float] | None = None
    limit: int = Field(default=10, ge=1, le=100)


class IndexInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    limit: int = Field(default=100, ge=1, le=1000)


async def validated_body(request: Request, schema: type[BaseModel]) -> BaseModel:
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise HTTPException(415, {"code": "CONTENT_TYPE", "message": "仅接受 JSON 请求"})
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(400, {"code": "INVALID_JSON", "message": "请求不是有效 JSON"}) from None
    try:
        return schema.model_validate(body)
    except ValidationError:
        # Pydantic's default diagnostics can echo credentials and full documents.
        raise HTTPException(422, {"code": "INVALID_INPUT", "message": "请求参数无效"}) from None


def encoded_result(value: Any) -> Any:
    return asdict(value) if is_dataclass(value) else value


def create_app(
    settings: Settings,
    *,
    upstream_transport: httpx.AsyncBaseTransport | None = None,
    engine: Any = None,
    knowledge: Any = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        (settings.home / "backend").mkdir(parents=True, exist_ok=True)
        app.state.upstream = httpx.AsyncClient(
            transport=upstream_transport,
            trust_env=False,
            follow_redirects=False,
            timeout=httpx.Timeout(connect=10, read=None, write=60, pool=10),
            limits=httpx.Limits(max_connections=64, max_keepalive_connections=16),
        )
        if engine is None:
            from cagent_backend.agent.engine import AgentEngine

            app.state.engine = AgentEngine(
                settings.upstream_origin, settings.internal_token.get_secret_value(), settings.home
            )
        else:
            app.state.engine = engine
        database = None
        try:
            await app.state.engine.open()
            if knowledge is None:
                from cagent_backend.knowledge import (
                    KnowledgeService,
                    Neo4jGraphStore,
                    OpenAICompatibleEmbedder,
                    QdrantVectorStore,
                )
                from cagent_backend.storage import Database

                database = Database(settings.service_database_url())
                await run_in_threadpool(database.migrate)
                vector = QdrantVectorStore(
                    url=settings.qdrant_url,
                    api_key=(
                        settings.qdrant_api_key.get_secret_value()
                        if settings.qdrant_api_key
                        else None
                    ),
                    path=str(settings.home / "backend" / "qdrant")
                    if not settings.qdrant_url
                    else None,
                )
                graph = None
                if settings.neo4j_uri and settings.neo4j_password:
                    graph = Neo4jGraphStore(
                        settings.neo4j_uri,
                        settings.neo4j_username,
                        settings.neo4j_password.get_secret_value(),
                        settings.neo4j_database,
                    )
                embedder = None
                if settings.embedding_url and settings.embedding_model and settings.embedding_key:
                    embedder = OpenAICompatibleEmbedder(
                        settings.embedding_url,
                        settings.embedding_model,
                        settings.embedding_key.get_secret_value(),
                    )
                app.state.knowledge = KnowledgeService(database, vector, graph, embedder)
            else:
                app.state.knowledge = knowledge
            yield
        finally:
            if hasattr(app.state, "knowledge"):
                await run_in_threadpool(app.state.knowledge.close)
            if database:
                await run_in_threadpool(database.close)
            await app.state.engine.close()
            await app.state.upstream.aclose()

    app = FastAPI(
        title="CAgent local backend",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.add_middleware(BoundaryMiddleware, settings=settings)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        if isinstance(exc.detail, dict):
            return error_response(
                exc.detail.get("code", "REQUEST_FAILED"),
                exc.detail.get("message", "请求失败"),
                exc.status_code,
            )
        return error_response("REQUEST_FAILED", "请求失败", exc.status_code)

    def upstream_headers(request: Request) -> list[tuple[str, str]]:
        headers = safe_headers(request.headers, request=True)
        headers.append(("host", urlsplit(settings.upstream_origin).netloc))
        headers.append(("accept-encoding", "identity"))
        # Do not grant an Origin to cookie writes that arrived without one.
        if request.headers.get("origin"):
            headers.append(("origin", settings.upstream_origin))
        return headers

    def require_internal(request: Request) -> None:
        authorization = request.headers.get("authorization", "")
        expected = "Bearer " + settings.internal_token.get_secret_value()
        if not hmac.compare_digest(authorization.encode(), expected.encode()):
            raise HTTPException(401, {"code": "UNAUTHORIZED", "message": "内部凭据无效"})

    def upstream_request(request: Request, method: str, url: str, **kwargs: Any) -> httpx.Request:
        forwarded_headers = upstream_headers(request)
        outbound = app.state.upstream.build_request(
            method, url, headers=forwarded_headers, **kwargs
        )
        # One shared pool serves independent UI connections. Its cookie jar must
        # never grant the preceding browser session's credentials to a new one.
        outbound.headers.pop("cookie", None)
        for name, value in forwarded_headers:
            if name.lower() == "cookie":
                outbound.headers["cookie"] = value
        return outbound

    async def authenticated_worker(
        request: Request, *, agents: bool = False, mutating: bool = False
    ) -> dict:
        # The public gateway must never inject privileged worker credentials.
        bearer = request.headers.get("authorization", "")
        public = "Bearer " + settings.public_token.get_secret_value()
        by_bearer = hmac.compare_digest(bearer.encode(), public.encode())
        if mutating and not by_bearer and not request.headers.get("origin"):
            raise HTTPException(
                403, {"code": "INVALID_ORIGIN", "message": "修改请求必须来自本应用"}
            )
        route = "/api/v1/bootstrap" if agents else "/api/v1/health"
        try:
            outgoing = upstream_request(
                request,
                "GET",
                settings.upstream_origin + route,
                timeout=15,
            )
            response = await app.state.upstream.send(outgoing)
        except httpx.HTTPError:
            raise HTTPException(
                502, {"code": "WORKER_UNAVAILABLE", "message": "本机业务服务暂时不可用"}
            ) from None
        if response.status_code != 200:
            status = response.status_code if response.status_code in (401, 403) else 502
            raise HTTPException(status, {"code": "UNAUTHORIZED", "message": "请连接此 CAgent 实例"})
        try:
            data = response.json()["data"]
            if not isinstance(data, dict):
                raise TypeError
            return data
        except (ValueError, KeyError, TypeError):
            raise HTTPException(
                502, {"code": "WORKER_RESPONSE", "message": "本机业务服务响应无效"}
            ) from None

    async def agent_namespace(request: Request, agent_id: str, *, mutating: bool = False):
        from cagent_backend.knowledge import Namespace

        data = await authenticated_worker(request, agents=True, mutating=mutating)
        if not any(agent.get("id") == agent_id for agent in data.get("agents", [])):
            raise HTTPException(404, {"code": "NOT_FOUND", "message": "助手不存在"})
        return Namespace("local-instance", agent_id, "default")

    async def knowledge_call(method: str, *args: Any, **kwargs: Any) -> Any:
        from cagent_backend.knowledge import KnowledgeError

        try:
            result = await run_in_threadpool(getattr(app.state.knowledge, method), *args, **kwargs)
            return encoded_result(result)
        except KnowledgeError as exc:
            status = getattr(exc, "status", 400)
            raise HTTPException(status, {"code": exc.code, "message": str(exc)}) from None
        except Exception:
            raise HTTPException(
                503, {"code": "KNOWLEDGE_UNAVAILABLE", "message": "知识服务暂时不可用"}
            ) from None

    @app.get("/api/v1/architecture")
    async def architecture(request: Request):
        await authenticated_worker(request)
        database = settings.service_database_url().split(":", 1)[0].split("+", 1)[0]
        return {
            "data": {
                "backend": "fastapi",
                "agent": "langgraph",
                "agentEngine": "langgraph",
                "modelIntegration": "langchain",
                "database": database,
                "vectorStore": "qdrant",
                "graphStore": "neo4j"
                if settings.neo4j_uri and settings.neo4j_password
                else "disabled",
                "compatibilityWorker": "node",
                "runtime": "independent",
                "migration": "compatibility-services",
            }
        }

    @app.post("/internal/v1/graph/runs")
    async def graph_run(request: Request):
        from cagent_backend.agent.engine import GraphError

        require_internal(request)
        data = await validated_body(request, GraphRunInput)
        try:
            return await app.state.engine.execute(data.runId, data.maxToolRounds, data.purpose)
        except GraphError as exc:
            return error_response(exc.code, exc.message, exc.status)
        except asyncio.CancelledError:
            return error_response("RUN_CANCELLED", "任务已取消", 409)

    @app.post("/internal/v1/graph/runs/{run_id}/cancel")
    async def graph_cancel(request: Request, run_id: str):
        require_internal(request)
        if not 1 <= len(run_id) <= 150:
            raise HTTPException(422, {"code": "INVALID_INPUT", "message": "任务编号无效"})
        return {"cancelled": await app.state.engine.cancel(run_id)}

    @app.get("/api/v1/knowledge/{agent_id}/health")
    async def knowledge_health(request: Request, agent_id: str):
        await agent_namespace(request, agent_id)
        return {"data": await knowledge_call("health")}

    @app.get("/api/v1/knowledge/{agent_id}/documents")
    async def documents(request: Request, agent_id: str, limit: int = 100):
        namespace = await agent_namespace(request, agent_id)
        if not 1 <= limit <= 100:
            raise HTTPException(422, {"code": "INVALID_INPUT", "message": "查询数量无效"})
        return {"data": await knowledge_call("list_documents", namespace, limit=limit)}

    @app.post("/api/v1/knowledge/{agent_id}/documents")
    async def ingest(request: Request, agent_id: str):
        namespace = await agent_namespace(request, agent_id, mutating=True)
        data = await validated_body(request, DocumentInput)
        return {
            "data": await knowledge_call(
                "ingest_text",
                namespace,
                data.documentId,
                data.text,
                vectors=data.vectors,
                metadata=data.metadata,
                graph=data.graph,
            )
        }

    @app.post("/api/v1/knowledge/{agent_id}/search")
    async def knowledge_search(request: Request, agent_id: str):
        namespace = await agent_namespace(request, agent_id)
        data = await validated_body(request, SearchInput)
        return {
            "data": await knowledge_call(
                "search",
                namespace,
                query_text=data.queryText,
                query_vector=data.queryVector,
                limit=data.limit,
            )
        }

    @app.get("/api/v1/knowledge/{agent_id}/documents/{document_id}")
    async def document(request: Request, agent_id: str, document_id: str):
        namespace = await agent_namespace(request, agent_id)
        result = await knowledge_call("get_document", namespace, document_id)
        if result is None:
            raise HTTPException(404, {"code": "NOT_FOUND", "message": "文档不存在"})
        return {"data": result}

    @app.delete("/api/v1/knowledge/{agent_id}/documents/{document_id}")
    async def delete_document(request: Request, agent_id: str, document_id: str):
        namespace = await agent_namespace(request, agent_id, mutating=True)
        return {"data": await knowledge_call("delete_document", namespace, document_id)}

    @app.get("/api/v1/knowledge/{agent_id}/entities/{entity_id}/neighbors")
    async def entity_neighbors(request: Request, agent_id: str, entity_id: str, limit: int = 20):
        namespace = await agent_namespace(request, agent_id)
        if not 1 <= limit <= 100:
            raise HTTPException(422, {"code": "INVALID_INPUT", "message": "查询数量无效"})
        return {"data": await knowledge_call("graph_neighbors", namespace, entity_id, limit=limit)}

    @app.post("/api/v1/knowledge/{agent_id}/index")
    async def index_pending(request: Request, agent_id: str):
        namespace = await agent_namespace(request, agent_id, mutating=True)
        data = await validated_body(request, IndexInput)
        return {
            "data": await knowledge_call("process_pending", namespace=namespace, limit=data.limit)
        }

    @app.api_route(
        "/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    )
    async def proxy(request: Request, path: str):
        decoded_path = unquote(path)
        segments = decoded_path.split("/")
        if (
            "\\" in decoded_path
            or "\x00" in decoded_path
            or any(segment in {".", ".."} for segment in segments)
            or decoded_path == "internal"
            or decoded_path.startswith("internal/")
        ):
            return error_response("NOT_FOUND", "接口不存在", 404)
        try:
            body = await request.body()
            # Quote decoded paths and append the original query to the fixed origin only.
            url = settings.upstream_origin + "/" + quote(path, safe="/@:@!$&'()*+,;=-._~")
            if request.scope.get("query_string"):
                url += "?" + request.scope["query_string"].decode("ascii")
            outgoing = upstream_request(
                request,
                request.method,
                url,
                content=body,
            )
            response = await app.state.upstream.send(outgoing, stream=True)
        except ClientDisconnect:
            return error_response("REQUEST_CANCELLED", "请求已取消", 499)
        except httpx.HTTPError:
            return error_response("WORKER_UNAVAILABLE", "本机业务服务暂时不可用", 502)

        async def stream() -> AsyncIterator[bytes]:
            try:
                async for chunk in response.aiter_bytes():
                    yield chunk
            finally:
                # Starlette cancels its AnyIO response scope on client disconnect.
                # Shield socket release so an abandoned event stream cannot hold
                # a compatibility-worker connection indefinitely.
                with CancelScope(shield=True):
                    await response.aclose()

        forwarded = StreamingResponse(stream(), status_code=response.status_code)
        forwarded.raw_headers = [
            (name.encode("latin-1"), value.encode("latin-1"))
            for name, value in safe_headers(response.headers, request=False)
        ]
        return forwarded

    return app
