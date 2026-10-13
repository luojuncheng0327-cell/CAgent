"""Durable, callback driven LangGraph engine for the local CAgent worker.

The graph deliberately stores references only: model transcripts, credentials and tool
arguments stay inside the authenticated TypeScript runtime.  A tool callback is one
single-effect boundary.  The checkpointer is therefore a safety boundary, rather than
a place from which a possibly effective operation can be replayed.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, TypedDict

import aiosqlite
import httpx
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph


class GraphError(RuntimeError):
    def __init__(self, code: str, message: str = "Agent 编排未能完成", status: int = 409) -> None:
        self.code = code
        self.message = message
        self.status = status
        super().__init__(f"{code}: {message}")


class GraphState(TypedDict, total=False):
    run_id: str
    purpose: Literal["chat", "compact"]
    max_tool_rounds: int
    round: int
    calls: list[dict[str, str]]
    status: str


@dataclass(slots=True)
class _Run:
    task: asyncio.Task[Any]
    cancel: asyncio.Event
    owner: asyncio.Task[Any] | None


class AgentEngine:
    def __init__(
        self,
        upstream_origin: str,
        internal_token: str,
        home: str | Path,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        origin = httpx.URL(upstream_origin)
        if (
            origin.scheme != "http"
            or origin.host not in {"127.0.0.1", "::1"}
            or origin.path not in {"", "/"}
            or origin.username
            or origin.password
            or origin.query
            or origin.fragment
        ):
            raise GraphError("GRAPH_INVALID_ORIGIN", "回调地址必须是本机 HTTP 服务")
        if not internal_token or len(internal_token) > 512:
            raise GraphError("GRAPH_INVALID_TOKEN", "内部凭据无效")
        self.origin = str(origin).rstrip("/")
        self.internal_token = internal_token
        self.home = Path(home)
        self.db_path = self.home / "backend" / "checkpoints.sqlite"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.transport = transport
        self._connection: aiosqlite.Connection | None = None
        self._saver: AsyncSqliteSaver | None = None
        self._runs: dict[str, _Run] = {}
        self._lock = asyncio.Lock()
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> AgentEngine:
        await self.open()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def open(self) -> None:
        async with self._lock:
            if self._client is not None:
                return
            self._connection = await aiosqlite.connect(self.db_path)
            self._saver = AsyncSqliteSaver(self._connection)
            await self._saver.setup()
            await self._connection.execute(
                "CREATE TABLE IF NOT EXISTS agent_runs "
                "(run_id TEXT PRIMARY KEY, status TEXT NOT NULL)"
            )
            await self._connection.commit()
            self._client = httpx.AsyncClient(
                transport=self.transport,
                trust_env=False,
                # Runtime requests, approvals and compaction each own their timeout. A graph
                # callback can span multiple network attempts or many summary batches.
                timeout=httpx.Timeout(connect=5.0, read=None, write=30.0, pool=5.0),
                headers={"Authorization": f"Bearer {self.internal_token}"},
                follow_redirects=False,
            )

    async def close(self) -> None:
        active = list(self._runs.values())
        for run in active:
            run.cancel.set()
            run.task.cancel()
        if active:
            await asyncio.gather(*(run.owner or run.task for run in active), return_exceptions=True)
        self._runs.clear()
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        if self._connection is not None:
            await self._connection.close()
            self._connection = None
        self._saver = None

    async def _claim(self, run_id: str, purpose: str) -> None:
        if not isinstance(run_id, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,150}", run_id) is None:
            raise GraphError("GRAPH_INVALID_RUN", "执行标识无效")
        if purpose not in {"chat", "compact"}:
            raise GraphError("GRAPH_INVALID_PURPOSE", "执行目的无效")
        assert self._connection is not None
        async with self._lock:
            async with self._connection.execute(
                "SELECT 1 FROM agent_runs WHERE run_id=? "
                "UNION ALL SELECT 1 FROM checkpoints WHERE thread_id=? LIMIT 1",
                (run_id, run_id),
            ) as cursor:
                row = await cursor.fetchone()
            if row is not None:
                raise GraphError("GRAPH_RUN_REUSED", "执行标识已经使用")
            async with self._connection.execute(
                "INSERT INTO agent_runs(run_id,status) VALUES (?,?) ON CONFLICT DO NOTHING",
                (run_id, "running"),
            ) as cursor:
                claimed = cursor.rowcount
            await self._connection.commit()
            if claimed != 1:
                raise GraphError("GRAPH_RUN_REUSED", "执行标识已经使用")

    async def _set_status(self, run_id: str, status: str) -> None:
        assert self._connection is not None
        await self._connection.execute(
            "UPDATE agent_runs SET status=? WHERE run_id=?", (status, run_id)
        )
        await self._connection.commit()

    async def _bridge(self, run_id: str, operation: str, body: dict[str, Any]) -> dict[str, Any]:
        assert self._client is not None
        try:
            response = await self._client.post(
                f"{self.origin}/internal/v1/runs/{run_id}/steps/{operation}", json=body
            )
        except (TimeoutError, httpx.HTTPError):
            raise GraphError("GRAPH_BRIDGE_UNAVAILABLE", "运行时回调暂时无法连接", 503) from None
        try:
            data = response.json()
        except ValueError:
            raise GraphError("GRAPH_BRIDGE_INVALID", "运行时回调响应无效", 502) from None
        if not response.is_success:
            error = data.get("error") if isinstance(data, dict) else None
            code = error.get("code") if isinstance(error, dict) else None
            if not isinstance(code, str) or re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", code) is None:
                code = "GRAPH_BRIDGE_REJECTED"
            raise GraphError(code, "运行时拒绝了当前步骤", response.status_code)
        if not isinstance(data, dict):
            raise GraphError("GRAPH_BRIDGE_INVALID", "运行时回调响应无效")
        return data

    async def _run_graph(self, state: GraphState, cancel: asyncio.Event) -> GraphState:
        assert self._saver is not None
        run_id = state["run_id"]
        # Definitions are transient. Checkpoints carry IDs and names only.
        descriptions: dict[str, str] = {}

        async def model_node(current: GraphState) -> GraphState:
            if cancel.is_set():
                raise asyncio.CancelledError
            data = await self._bridge(run_id, "model", {"round": current["round"]})
            calls = data.get("calls")
            if not isinstance(calls, list) or any(
                not isinstance(call, dict)
                or not isinstance(call.get("id"), str)
                or not call["id"]
                or not isinstance(call.get("name"), str)
                or not call["name"]
                for call in calls
            ):
                raise GraphError("GRAPH_BRIDGE_INVALID", "模型步骤响应无效")
            refs = [{"id": call["id"], "name": call["name"]} for call in calls]
            for tool in data.get("tools", []):
                if isinstance(tool, dict) and isinstance(tool.get("name"), str):
                    descriptions[tool["name"]] = str(tool.get("description") or "运行时工具")
            return {"calls": refs, "status": "model" if refs else "succeeded"}

        async def tools_node(current: GraphState) -> GraphState:
            if cancel.is_set():
                raise asyncio.CancelledError
            for call in current.get("calls", []):
                if cancel.is_set():
                    raise asyncio.CancelledError

                # Bind one saved model call to a LangChain tool. Neither LangChain nor the graph
                # can replace its arguments: the runtime retrieves them from its live context.
                async def invoke(
                    call_id: str = call["id"], round_number: int = current["round"]
                ) -> dict[str, Any]:
                    return await self._bridge(
                        run_id, "tool", {"round": round_number, "callId": call_id}
                    )

                tool = StructuredTool.from_function(
                    coroutine=invoke,
                    name=call["name"],
                    description=descriptions.get(call["name"], "运行时工具"),
                )
                await tool.ainvoke({})
            return {"calls": [], "round": current["round"] + 1, "status": "tools"}

        async def compact_node(current: GraphState) -> GraphState:
            if cancel.is_set():
                raise asyncio.CancelledError
            await self._bridge(run_id, "compact", {})
            return {"status": "succeeded"}

        async def limit_node(_: GraphState) -> GraphState:
            raise GraphError("TOOL_ROUND_LIMIT", "已达到本次工具执行轮数上限")

        graph = StateGraph(GraphState)
        graph.add_node("model", model_node)
        graph.add_node("tools", tools_node)
        graph.add_node("compact", compact_node)
        graph.add_node("limit", limit_node)
        graph.add_edge(START, "compact" if state["purpose"] == "compact" else "model")
        graph.add_conditional_edges(
            "model",
            lambda current: "end" if not current.get("calls") else "tools",
            {"tools": "tools", "end": END},
        )
        graph.add_conditional_edges(
            "tools",
            lambda current: "limit" if current["round"] >= current["max_tool_rounds"] else "model",
            {"model": "model", "limit": "limit"},
        )
        graph.add_edge("compact", END)
        graph.add_edge("limit", END)
        compiled = graph.compile(checkpointer=self._saver)
        config = {
            "configurable": {"thread_id": run_id},
            "recursion_limit": state["max_tool_rounds"] * 2 + 3,
        }
        return await compiled.ainvoke(state, config)

    async def execute(
        self, run_id: str, max_tool_rounds: int, purpose: str = "chat"
    ) -> dict[str, str]:
        if (
            isinstance(max_tool_rounds, bool)
            or not isinstance(max_tool_rounds, int)
            or not 1 <= max_tool_rounds <= 32
        ):
            raise GraphError("GRAPH_INVALID_LIMIT", "工具执行轮数必须在 1 到 32 之间")
        await self.open()
        await self._claim(run_id, purpose)
        cancel = asyncio.Event()
        task = asyncio.create_task(
            self._run_graph(
                {
                    "run_id": run_id,
                    "purpose": purpose,
                    "max_tool_rounds": max_tool_rounds,
                    "round": 0,
                    "calls": [],
                    "status": "running",
                },
                cancel,
            )
        )
        self._runs[run_id] = _Run(task, cancel, asyncio.current_task())
        try:
            result = await task
            if result.get("status") != "succeeded":
                raise GraphError("GRAPH_INCOMPLETE", "Agent 编排未完整结束", 502)
            await self._set_status(run_id, "succeeded")
            return {"runId": run_id, "status": "succeeded"}
        except asyncio.CancelledError:
            await self._set_status(run_id, "cancelled")
            raise
        except Exception:
            await self._set_status(run_id, "failed")
            raise
        finally:
            self._runs.pop(run_id, None)

    async def cancel(self, run_id: str) -> bool:
        run = self._runs.get(run_id)
        if run is None:
            return False
        run.cancel.set()
        run.task.cancel()
        await asyncio.gather(run.owner or run.task, return_exceptions=True)
        return True

    async def snapshot(self, run_id: str) -> dict[str, Any]:
        assert self._connection is not None
        async with self._connection.execute(
            "SELECT status FROM agent_runs WHERE run_id=?", (run_id,)
        ) as cursor:
            row = await cursor.fetchone()
        if row is None:
            raise GraphError("GRAPH_RUN_UNKNOWN", "执行不存在")
        assert self._saver is not None
        checkpoint = await self._saver.aget({"configurable": {"thread_id": run_id}})
        values = checkpoint["channel_values"] if checkpoint else {}
        return {**values, "status": row[0], "run_id": run_id}
