from __future__ import annotations

import asyncio
import gzip
import json
import os
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest

from cagent_backend.app import create_app
from cagent_backend.settings import Settings

GATEWAY = "http://127.0.0.1:5101"
UPSTREAM = "http://127.0.0.1:5102"
PUBLIC_TOKEN = "public-credential-for-gateway-1234"
INTERNAL_TOKEN = "internal-credential-for-graph-5678"
BACKEND_ROOT = str(Path(__file__).resolve().parents[1])


class FakeEngine:
    def __init__(self):
        self.runs = []
        self.cancelled = []

    async def open(self):
        pass

    async def close(self):
        pass

    async def execute(self, run_id, max_tool_rounds, purpose):
        self.runs.append((run_id, max_tool_rounds, purpose))
        return {"runId": run_id, "status": "succeeded"}

    async def cancel(self, run_id):
        self.cancelled.append(run_id)
        return True


@dataclass
class FakeResult:
    document_id: str
    method: str = "lexical"


class FakeKnowledge:
    def __init__(self):
        self.calls = []

    def close(self):
        pass

    def health(self):
        return {"graph": {"enabled": False, "available": False}}

    def ingest_text(self, namespace, document_id, text, **kwargs):
        self.calls.append((namespace, document_id, text, kwargs))
        return FakeResult(document_id)

    def search(self, namespace, **kwargs):
        self.calls.append((namespace, kwargs))
        return FakeResult("doc")

    def get_document(self, namespace, document_id):
        return FakeResult(document_id)

    def delete_document(self, namespace, document_id):
        self.calls.append((namespace, document_id))
        return FakeResult(document_id)


@asynccontextmanager
async def gateway(tmp_path, handler, *, knowledge=None):
    config = Settings(
        home=tmp_path,
        upstreamOrigin=UPSTREAM,
        publicToken=PUBLIC_TOKEN,
        internalToken=INTERNAL_TOKEN,
        gateway_origin=GATEWAY,
    )
    engine = FakeEngine()
    app = create_app(
        config,
        upstream_transport=httpx.MockTransport(handler),
        engine=engine,
        knowledge=knowledge or FakeKnowledge(),
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=GATEWAY
        ) as client:
            yield client, app, engine


@pytest.mark.parametrize("headers", [{"Host": "evil.invalid"}, {"Origin": "https://evil.invalid"}])
async def test_untrusted_host_or_origin_never_reaches_worker(tmp_path, headers):
    calls = []

    def worker(request):
        calls.append(request)
        return httpx.Response(200)

    async with gateway(tmp_path, worker) as (client, _, _):
        response = await client.get("/api/v1/health", headers=headers)
    assert response.status_code == 403
    assert not calls


async def test_proxy_translates_only_valid_origin_and_preserves_cookie_auth(tmp_path):
    seen = []

    def worker(request):
        seen.append(request)
        return httpx.Response(
            200,
            json={"data": {"authenticated": True}},
            headers={"Set-Cookie": "cagent_session=known; Path=/; HttpOnly; SameSite=Strict"},
        )

    async with gateway(tmp_path, worker) as (client, _, _):
        login = await client.post(
            "/api/v1/auth", json={"token": PUBLIC_TOKEN}, headers={"Origin": GATEWAY}
        )
        await client.get("/api/v1/health")
    assert login.status_code == 200
    assert "HttpOnly" in login.headers["set-cookie"]
    assert seen[0].headers["host"] == "127.0.0.1:5102"
    assert seen[0].headers["origin"] == UPSTREAM
    assert "origin" not in seen[1].headers
    assert seen[1].headers["cookie"] == "cagent_session=known"


async def test_cookie_mutations_without_origin_do_not_gain_upstream_origin(tmp_path):
    seen = []

    def worker(request):
        seen.append(request)
        return httpx.Response(403, json={"error": {"code": "INVALID_ORIGIN"}})

    async with gateway(tmp_path, worker) as (client, _, _):
        response = await client.put(
            "/api/v1/preferences", json={}, headers={"Cookie": "cagent_session=known"}
        )
    assert response.status_code == 403
    assert "origin" not in seen[0].headers


async def test_shared_pool_never_supplies_another_clients_login_cookie(tmp_path):
    seen = []

    def worker(request):
        seen.append(request)
        if request.url.path == "/api/v1/auth":
            return httpx.Response(
                200,
                json={"data": {"authenticated": True}},
                headers={"Set-Cookie": "cagent_session=known; Path=/; HttpOnly; SameSite=Strict"},
            )
        authenticated = request.headers.get("cookie") == "cagent_session=known"
        return httpx.Response(
            200 if authenticated else 401, json={"data": {"runtime": "independent"}}
        )

    async with gateway(tmp_path, worker) as (client, app, _):
        await client.post("/api/v1/auth", json={"token": PUBLIC_TOKEN})
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=GATEWAY
        ) as other_client:
            public_health = await other_client.get("/api/v1/health")
            architecture = await other_client.get("/api/v1/architecture")
            hop_cookie = await other_client.get(
                "/api/v1/health",
                headers={"Cookie": "attacker-cookie=invalid", "Connection": "Cookie"},
            )
    assert public_health.status_code == 401
    assert architecture.status_code == 401
    assert hop_cookie.status_code == 401
    assert "cookie" not in seen[1].headers
    assert "cookie" not in seen[2].headers
    assert "cookie" not in seen[3].headers


async def test_architecture_requires_existing_worker_auth(tmp_path):
    def worker(request):
        assert request.url.path == "/api/v1/health"
        if request.headers.get("cookie") == "cagent_session=known":
            return httpx.Response(200, json={"data": {"runtime": "independent"}})
        return httpx.Response(401, json={"error": {"code": "UNAUTHORIZED"}})

    async with gateway(tmp_path, worker) as (client, _, _):
        denied = await client.get("/api/v1/architecture")
        allowed = await client.get(
            "/api/v1/architecture", headers={"Cookie": "cagent_session=known"}
        )
    assert denied.status_code == 401
    assert allowed.json()["data"]["agentEngine"] == "langgraph"
    assert "token" not in str(allowed.json()).lower()


async def test_worker_internals_are_never_proxied_to_public(tmp_path):
    calls = []

    def worker(request):
        calls.append(request)
        return httpx.Response(200)

    async with gateway(tmp_path, worker) as (client, _, engine):
        blocked = await client.post(
            "/internal/v1/runs/abc/steps/tool",
            headers={"Authorization": f"Bearer {PUBLIC_TOKEN}"},
        )
        denied = await client.post(
            "/internal/v1/graph/runs",
            json={"runId": "run-1", "maxToolRounds": 4},
            headers={"Authorization": f"Bearer {PUBLIC_TOKEN}"},
        )
        executed = await client.post(
            "/internal/v1/graph/runs",
            json={"runId": "run-1", "maxToolRounds": 4},
            headers={"Authorization": f"Bearer {INTERNAL_TOKEN}"},
        )
        cancelled = await client.post(
            "/internal/v1/graph/runs/run-1/cancel",
            headers={"Authorization": f"Bearer {INTERNAL_TOKEN}"},
        )
    assert blocked.status_code == 404
    assert denied.status_code == 401
    assert executed.status_code == 200
    assert engine.runs == [("run-1", 4, "chat")]
    assert cancelled.json() == {"cancelled": True}
    assert engine.cancelled == ["run-1"]
    assert not calls


@pytest.mark.parametrize(
    "path",
    [
        "/static/%2e%2e/internal/v1/runs/abc/steps/tool",
        "/%2e/internal/v1/runs/abc/steps/tool",
        "/static/%5cinternal/v1/runs/abc/steps/tool",
    ],
)
async def test_encoded_path_normalization_cannot_reach_worker_internals(tmp_path, path):
    calls = []

    def worker(request):
        calls.append(request)
        return httpx.Response(200)

    async with gateway(tmp_path, worker) as (client, _, _):
        response = await client.post(path, headers={"Authorization": f"Bearer {PUBLIC_TOKEN}"})
    assert response.status_code in (403, 404)
    assert not calls


async def test_oversized_stream_is_rejected_before_any_upstream_action(tmp_path, monkeypatch):
    import cagent_backend.app as module

    monkeypatch.setattr(module, "MAX_REQUEST_BYTES", 16)
    seen = []

    async def body():
        yield b"1234567890"
        yield b"1234567890"

    def worker(request):
        seen.append(request)
        return httpx.Response(200)

    async with gateway(tmp_path, worker) as (client, _, _):
        response = await client.post("/api/v1/upload", content=body())
    assert response.status_code == 413
    assert not seen


async def test_body_length_is_checked_before_reading_and_worker_errors_are_sanitized(tmp_path):
    def worker(request):
        raise httpx.ConnectError("secret upstream diagnostic", request=request)

    async with gateway(tmp_path, worker) as (client, _, _):
        oversized = await client.post(
            "/api/v1/upload", content=b"", headers={"Content-Length": str(49 * 1024 * 1024)}
        )
        unavailable = await client.get("/api/v1/health")
    assert oversized.status_code == 413
    assert unavailable.status_code == 502
    assert "secret" not in unavailable.text


async def test_compressed_binary_and_hop_headers_are_forwarded_safely(tmp_path):
    content = bytes(range(256))

    def worker(request):
        assert "x-hop-secret" not in request.headers
        assert "x-forwarded-host" not in request.headers
        return httpx.Response(
            200,
            content=gzip.compress(content),
            headers={
                "Content-Encoding": "gzip",
                "Content-Type": "application/octet-stream",
                "Connection": "x-worker-secret",
                "X-Worker-Secret": "internal",
            },
        )

    async with gateway(tmp_path, worker) as (client, _, _):
        response = await client.get(
            "/api/v1/resource",
            headers={
                "Connection": "x-hop-secret",
                "X-Hop-Secret": "do not forward",
                "X-Forwarded-Host": "evil.invalid",
            },
        )
    assert response.content == content
    assert "content-encoding" not in response.headers
    assert "x-worker-secret" not in response.headers


class EventStream(httpx.AsyncByteStream):
    def __init__(self):
        self.closed = False

    async def __aiter__(self):
        yield b"data: first\n\n"
        yield b"data: done\n\n"

    async def aclose(self):
        self.closed = True


async def test_sse_events_remain_streamed_and_upstream_is_closed(tmp_path):
    stream = EventStream()

    def worker(request):
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=stream)

    async with gateway(tmp_path, worker) as (client, _, _):
        async with client.stream("GET", "/api/v1/events") as response:
            data = b"".join([chunk async for chunk in response.aiter_bytes()])
    assert data == b"data: first\n\ndata: done\n\n"
    assert stream.closed


async def test_disconnected_sse_client_closes_upstream_socket(tmp_path):
    class LongStream(httpx.AsyncByteStream):
        def __init__(self):
            self.closed = False

        async def __aiter__(self):
            yield b"data: first\n\n"
            await asyncio.Event().wait()

        async def aclose(self):
            await asyncio.sleep(0)
            self.closed = True

    stream = LongStream()

    def worker(request):
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=stream)

    async with gateway(tmp_path, worker) as (_, app, _):
        event_sent = asyncio.Event()
        request_sent = False

        async def receive():
            nonlocal request_sent
            if not request_sent:
                request_sent = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await event_sent.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.body" and message.get("body"):
                event_sent.set()

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api/v1/events",
            "raw_path": b"/api/v1/events",
            "query_string": b"",
            "root_path": "",
            "headers": [(b"host", b"127.0.0.1:5101")],
            "server": ("127.0.0.1", 5101),
            "client": ("127.0.0.1", 5200),
        }
        await asyncio.wait_for(app(scope, receive, send), timeout=5)
    assert event_sent.is_set()
    assert stream.closed


async def test_knowledge_scope_comes_from_authenticated_existing_agent(tmp_path):
    knowledge = FakeKnowledge()

    def worker(request):
        if request.headers.get("cookie") != "cagent_session=known":
            return httpx.Response(401, json={"error": {"code": "UNAUTHORIZED"}})
        return httpx.Response(200, json={"data": {"agents": [{"id": "agent-1"}]}})

    headers = {"Cookie": "cagent_session=known", "Origin": GATEWAY}
    async with gateway(tmp_path, worker, knowledge=knowledge) as (client, _, _):
        unknown = await client.post(
            "/api/v1/knowledge/other/documents",
            headers=headers,
            json={"documentId": "doc-1", "text": "text"},
        )
        spoofed = await client.post(
            "/api/v1/knowledge/agent-1/documents",
            headers=headers,
            json={"documentId": "doc-1", "text": "text", "tenantId": "other"},
        )
        missing_origin = await client.post(
            "/api/v1/knowledge/agent-1/documents",
            headers={"Cookie": "cagent_session=known"},
            json={"documentId": "doc-1", "text": "text"},
        )
        created = await client.post(
            "/api/v1/knowledge/agent-1/documents",
            headers=headers,
            json={"documentId": "doc-1", "text": "text"},
        )
    assert unknown.status_code == 404
    assert spoofed.status_code == 422
    assert missing_origin.status_code == 403
    assert created.status_code == 200
    namespace, document_id, _, _ = knowledge.calls[0]
    assert namespace.tenant_id == "local-instance"
    assert namespace.agent_id == "agent-1"
    assert namespace.space_id == "default"
    assert document_id == "doc-1"


async def test_desktop_knowledge_api_works_without_external_services(tmp_path):
    def worker(request):
        if request.headers.get("authorization") != "Bearer " + PUBLIC_TOKEN:
            return httpx.Response(401)
        return httpx.Response(200, json={"data": {"agents": [{"id": "agent-1"}]}})

    settings = Settings(
        home=tmp_path,
        upstreamOrigin=UPSTREAM,
        publicToken=PUBLIC_TOKEN,
        internalToken=INTERNAL_TOKEN,
        gateway_origin=GATEWAY,
    )
    app = create_app(settings, upstream_transport=httpx.MockTransport(worker), engine=FakeEngine())
    headers = {"Authorization": "Bearer " + PUBLIC_TOKEN}
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=GATEWAY, headers=headers
        ) as client:
            imported = await client.post(
                "/api/v1/knowledge/agent-1/documents",
                json={
                    "documentId": "migration-notes",
                    "text": "FastAPI manages local architecture",
                },
            )
            document = await client.get("/api/v1/knowledge/agent-1/documents/migration-notes")
            search = await client.post(
                "/api/v1/knowledge/agent-1/search", json={"queryText": "architecture"}
            )
            denied = await client.get("/api/v1/knowledge/other/documents/migration-notes")
            indexed = await client.post("/api/v1/knowledge/agent-1/index", json={"limit": 10})
            deleted = await client.delete("/api/v1/knowledge/agent-1/documents/migration-notes")
            missing = await client.get("/api/v1/knowledge/agent-1/documents/migration-notes")
    assert imported.status_code == 200
    assert imported.json()["data"]["graph_status"] == "not_configured"
    assert document.json()["data"]["document_id"] == "migration-notes"
    assert search.json()["data"]["method"] == "lexical"
    assert search.json()["data"]["hits"][0]["document_id"] == "migration-notes"
    assert denied.status_code == 404
    assert indexed.json()["data"]["processed"] == 0
    assert deleted.json()["data"]["deleted"] is True
    assert missing.status_code == 404


@pytest.mark.parametrize(
    "value", ["https://evil.invalid", "http://localhost:5102", UPSTREAM + "/api"]
)
def test_upstream_is_fixed_numeric_loopback_origin(tmp_path, value):
    with pytest.raises(ValueError):
        Settings(
            home=tmp_path,
            upstreamOrigin=value,
            publicToken=PUBLIC_TOKEN,
            internalToken=INTERNAL_TOKEN,
        )


async def test_cli_ready_is_loopback_and_parent_eof_releases_port(tmp_path):
    import socket

    env = {name: value for name, value in os.environ.items() if not name.startswith("CAGENT_")}
    env["PYTHONPATH"] = BACKEND_ROOT
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "cagent_backend",
        "--config-stdin",
        "--port=0",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        launch = {
            "home": str(tmp_path),
            "upstreamOrigin": UPSTREAM,
            "publicToken": PUBLIC_TOKEN,
            "internalToken": INTERNAL_TOKEN,
        }
        process.stdin.write((json.dumps(launch) + "\n").encode())
        await process.stdin.drain()
        line = await asyncio.wait_for(process.stdout.readline(), timeout=30)
        if not line:
            diagnostic = (await process.stderr.read()).decode()
            raise AssertionError("Backend did not announce readiness: " + diagnostic)
        ready = json.loads(line)
        assert ready["kind"] == "ready"
        assert ready["engine"] == "fastapi-langgraph"
        assert ready["origin"].startswith("http://127.0.0.1:")
        async with httpx.AsyncClient(trust_env=False) as client:
            denied = await client.get(ready["origin"] + "/api/v1/health", headers={"Host": "evil"})
        assert denied.status_code == 403
        process.stdin.close()
        await asyncio.wait_for(process.wait(), timeout=15)
        assert process.returncode == 0
        remainder = await process.stdout.read()
        diagnostics = await process.stderr.read()
        assert not remainder.strip()
        assert PUBLIC_TOKEN.encode() not in diagnostics
        assert INTERNAL_TOKEN.encode() not in diagnostics
        port = int(ready["origin"].rsplit(":", 1)[1])
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            assert probe.connect_ex(("127.0.0.1", port)) != 0
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_invalid_launch_configuration_never_logs_secrets(tmp_path):
    env = {name: value for name, value in os.environ.items() if not name.startswith("CAGENT_")}
    env["PYTHONPATH"] = BACKEND_ROOT
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "cagent_backend",
        "--config-stdin",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    output, error = await process.communicate(
        (
            json.dumps(
                {
                    "home": str(tmp_path),
                    "upstreamOrigin": "https://evil.invalid",
                    "publicToken": PUBLIC_TOKEN,
                    "internalToken": INTERNAL_TOKEN,
                }
            )
            + "\n"
        ).encode()
    )
    assert process.returncode == 2
    assert not output
    assert PUBLIC_TOKEN.encode() not in error
    assert INTERNAL_TOKEN.encode() not in error
    assert b"invalid launch configuration" in error


async def test_failed_lifespan_exits_cleanly_without_stdin_thread_fatal(tmp_path):
    env = {name: value for name, value in os.environ.items() if not name.startswith("CAGENT_")}
    env["PYTHONPATH"] = BACKEND_ROOT
    env["CAGENT_DATABASE_URL"] = "unsupported-db-driver://hidden-password@host/database"
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "cagent_backend",
        "--config-stdin",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        launch = {
            "home": str(tmp_path),
            "upstreamOrigin": UPSTREAM,
            "publicToken": PUBLIC_TOKEN,
            "internalToken": INTERNAL_TOKEN,
        }
        process.stdin.write((json.dumps(launch) + "\n").encode())
        await process.stdin.drain()
        # Keep stdin open while startup fails, exactly as the Electron supervisor.
        await asyncio.wait_for(process.wait(), timeout=30)
        output = await process.stdout.read()
        diagnostic = await process.stderr.read()
        assert process.returncode == 1
        assert not output
        assert b"Fatal Python error" not in diagnostic
        assert b"Task exception was never retrieved" not in diagnostic
        assert b"hidden-password" not in diagnostic
        assert PUBLIC_TOKEN.encode() not in diagnostic
        assert INTERNAL_TOKEN.encode() not in diagnostic
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
