import asyncio
import json
import sqlite3
from pathlib import Path

import httpx
import pytest

from cagent_backend.agent.engine import AgentEngine, GraphError


def tool_call(call_id="write-once"):
    return {
        "id": call_id,
        "name": "write_file",
        "arguments": json.dumps({"path": "private-file.txt", "text": "secret-transcript"}),
    }


def model_result(calls=None):
    return {
        "calls": calls or [],
        "tools": [
            {"name": "write_file", "description": "写文件", "parameters": {"type": "object"}}
        ],
    }


def engine(tmp_path, handler):
    return AgentEngine(
        "http://127.0.0.1:19991",
        "private-internal-token",
        tmp_path,
        transport=httpx.MockTransport(handler),
    )


async def test_graph_cycles_use_real_langchain_tools_and_persist_only_references(tmp_path):
    requests = []

    async def bridge(request):
        body = json.loads(request.content)
        requests.append((request.url.path, body, request.headers.get("authorization")))
        if request.url.path.endswith("/model"):
            data = model_result([tool_call()] if body["round"] == 0 else [])
        else:
            data = {"callId": body["callId"], "status": "completed"}
        return httpx.Response(200, json=data)

    async with engine(tmp_path, bridge) as runtime:
        result = await runtime.execute("run-1", 2)
        assert result == {"runId": "run-1", "status": "succeeded"}
        assert [item[0].rsplit("/", 1)[-1] for item in requests] == ["model", "tool", "model"]
        assert requests[1][1] == {"callId": "write-once", "round": 0}
        assert all(item[2] == "Bearer private-internal-token" for item in requests)
        state = await runtime.snapshot("run-1")
        assert state["round"] == 1
        assert state["calls"] == []

    with sqlite3.connect(tmp_path / "backend" / "checkpoints.sqlite") as database:
        assert database.execute("SELECT count(*) FROM checkpoints").fetchone()[0] >= 4
        tables = [
            row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")
        ]
        persisted = b"\n".join(
            cell if isinstance(cell, bytes) else str(cell).encode()
            for table in tables
            for row in database.execute(f'SELECT * FROM "{table}"')
            for cell in row
        )
    for secret in ["private-internal-token", "secret-transcript", "private-file.txt"]:
        assert secret.encode() not in persisted
    assert b"write-once" in persisted


async def test_round_limit_executes_last_tools_then_stops_without_extra_model(tmp_path):
    requests = []

    async def bridge(request):
        requests.append(request.url.path.rsplit("/", 1)[-1])
        data = model_result([tool_call()]) if requests[-1] == "model" else {"status": "completed"}
        return httpx.Response(200, json=data)

    async with engine(tmp_path, bridge) as runtime:
        with pytest.raises(GraphError, match="TOOL_ROUND_LIMIT"):
            await runtime.execute("limited", 1)
    assert requests == ["model", "tool"]


async def test_failed_tool_callback_is_not_retried_and_sanitizes_error(tmp_path):
    operations = []

    async def bridge(request):
        operation = request.url.path.rsplit("/", 1)[-1]
        operations.append(operation)
        if operation == "model":
            return httpx.Response(200, json=model_result([tool_call()]))
        return httpx.Response(
            409, json={"error": {"code": "DUPLICATE_TOOL_CALL", "message": "private-model-key"}}
        )

    async with engine(tmp_path, bridge) as runtime:
        with pytest.raises(GraphError) as failure:
            await runtime.execute("failed", 8)
        assert failure.value.code == "DUPLICATE_TOOL_CALL"
        assert "private-model-key" not in str(failure.value)
        with pytest.raises(GraphError) as duplicate:
            await runtime.execute("failed", 8)
        assert duplicate.value.code == "GRAPH_RUN_REUSED"
    assert operations == ["model", "tool"]


async def test_cancel_aborts_pending_callback_and_blocks_reuse_after_restart(tmp_path):
    pending = asyncio.Event()
    cancelled = asyncio.Event()

    async def bridge(request):
        if request.url.path.endswith("/model"):
            return httpx.Response(200, json=model_result([tool_call()]))
        pending.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async with engine(tmp_path, bridge) as runtime:
        task = asyncio.create_task(runtime.execute("cancelled", 8))
        await asyncio.wait_for(pending.wait(), timeout=3)
        assert await runtime.cancel("cancelled")
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cancelled.is_set()
        assert not await runtime.cancel("cancelled")

    async with engine(tmp_path, bridge) as reopened:
        with pytest.raises(GraphError) as failure:
            await reopened.execute("cancelled", 8)
        assert failure.value.code == "GRAPH_RUN_REUSED"


async def test_compaction_uses_own_graph_node_and_survives_reopen(tmp_path):
    operations = []

    async def bridge(request):
        operations.append(request.url.path.rsplit("/", 1)[-1])
        return httpx.Response(200, json={"completed": True})

    async with engine(tmp_path, bridge) as runtime:
        await runtime.execute("compact", 8, "compact")
    async with engine(tmp_path, bridge) as reopened:
        assert (await reopened.snapshot("compact"))["purpose"] == "compact"
        with pytest.raises(GraphError) as failure:
            await reopened.execute("compact", 8, "compact")
        assert failure.value.code == "GRAPH_RUN_REUSED"
    assert operations == ["compact"]


async def test_duplicate_concurrent_run_rejected_and_unknown_checkpoint_never_replayed(tmp_path):
    pending = asyncio.Event()
    release = asyncio.Event()
    operations = []

    async def bridge(request):
        operations.append(request.url.path.rsplit("/", 1)[-1])
        pending.set()
        await release.wait()
        return httpx.Response(200, json=model_result())

    async with engine(tmp_path, bridge) as runtime:
        task = asyncio.create_task(runtime.execute("same-id", 8))
        await asyncio.wait_for(pending.wait(), timeout=3)
        with pytest.raises(GraphError) as failure:
            await runtime.execute("same-id", 8)
        assert failure.value.code == "GRAPH_RUN_REUSED"
        release.set()
        await task
    assert operations == ["model"]
    # This marker simulates a process dying after a checkpoint and before recording completion.
    with sqlite3.connect(tmp_path / "backend" / "checkpoints.sqlite") as database:
        database.execute(
            "INSERT INTO agent_runs(run_id,status) VALUES (?,?)", ("unknown", "running")
        )
    async with engine(tmp_path, bridge) as reopened:
        with pytest.raises(GraphError) as failure:
            await reopened.execute("unknown", 8)
        assert failure.value.code == "GRAPH_RUN_REUSED"
    assert operations == ["model"]


async def test_invalid_purpose_rounds_and_remote_bridge_rejected(tmp_path):
    async def bridge(request):
        pytest.fail("invalid input must not call the model")

    with pytest.raises(GraphError):
        AgentEngine("https://example.com", "private-token", Path(tmp_path))
    async with engine(tmp_path, bridge) as runtime:
        for rounds in [0, 33, True]:
            with pytest.raises(GraphError):
                await runtime.execute("invalid", rounds)
        with pytest.raises(GraphError):
            await runtime.execute("invalid", 8, "resume")


async def test_callback_transport_failure_never_exposes_token_and_never_retries(tmp_path):
    requests = 0

    async def bridge(request):
        nonlocal requests
        requests += 1
        raise httpx.ConnectError("private-internal-token", request=request)

    async with engine(tmp_path, bridge) as runtime:
        with pytest.raises(GraphError) as failure:
            await runtime.execute("connection", 8)
        assert failure.value.code == "GRAPH_BRIDGE_UNAVAILABLE"
        assert "private-internal-token" not in str(failure.value)
    assert requests == 1


async def test_multiple_calls_use_distinct_langchain_bound_ids_without_persisting_arguments(
    tmp_path,
):
    ids = []

    async def bridge(request):
        body = json.loads(request.content)
        if request.url.path.endswith("/model"):
            return httpx.Response(
                200,
                json=model_result(
                    [tool_call("one"), tool_call("two")] if body["round"] == 0 else []
                ),
            )
        ids.append(body["callId"])
        return httpx.Response(200, json={"status": "completed"})

    async with engine(tmp_path, bridge) as runtime:
        await runtime.execute("two-tools", 8)
    assert ids == ["one", "two"]


async def test_shutdown_cancels_graph_owner_before_closing_checkpoint_database(tmp_path):
    pending = asyncio.Event()

    async def bridge(request):
        pending.set()
        await asyncio.Event().wait()

    runtime = engine(tmp_path, bridge)
    await runtime.open()
    task = asyncio.create_task(runtime.execute("shutdown", 8))
    await asyncio.wait_for(pending.wait(), timeout=3)
    await asyncio.wait_for(runtime.close(), timeout=3)
    with pytest.raises(asyncio.CancelledError):
        await task
    with sqlite3.connect(tmp_path / "backend" / "checkpoints.sqlite") as database:
        assert (
            database.execute("SELECT status FROM agent_runs WHERE run_id='shutdown'").fetchone()[0]
            == "cancelled"
        )


async def test_auto_open_concurrent_runs_share_one_database_and_allow_32_rounds(tmp_path):
    requests = {}

    async def bridge(request):
        run_id = request.url.path.split("/")[-3]
        body = json.loads(request.content)
        requests[run_id] = requests.get(run_id, 0) + 1
        if request.url.path.endswith("/model"):
            calls = (
                [tool_call(f"call-{body['round']}")]
                if run_id == "long" and body["round"] < 31
                else []
            )
            return httpx.Response(200, json=model_result(calls))
        return httpx.Response(200, json={"status": "completed"})

    runtime = engine(tmp_path, bridge)
    try:
        results = await asyncio.gather(runtime.execute("long", 32), runtime.execute("short", 1))
        assert all(result["status"] == "succeeded" for result in results)
        assert requests == {"long": 63, "short": 1}
    finally:
        await runtime.close()


async def test_orphaned_checkpoint_without_run_marker_is_never_replayed(tmp_path):
    requests = 0

    async def bridge(request):
        nonlocal requests
        requests += 1
        return httpx.Response(200, json=model_result())

    async with engine(tmp_path, bridge) as runtime:
        await runtime.execute("orphan", 8)
    with sqlite3.connect(tmp_path / "backend" / "checkpoints.sqlite") as database:
        database.execute("DELETE FROM agent_runs WHERE run_id='orphan'")
    async with engine(tmp_path, bridge) as reopened:
        with pytest.raises(GraphError) as failure:
            await reopened.execute("orphan", 8)
        assert failure.value.code == "GRAPH_RUN_REUSED"
    assert requests == 1
