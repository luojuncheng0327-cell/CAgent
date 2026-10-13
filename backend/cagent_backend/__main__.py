"""Start the loopback backend without putting credentials on the command line."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import socket
import sys
import threading

import uvicorn

from cagent_backend.app import create_app
from cagent_backend.settings import Settings


class PrivateFormatter(logging.Formatter):
    def __init__(self, secrets: list[str]):
        super().__init__("%(levelname)s %(name)s: %(message)s")
        self.secrets = [secret for secret in secrets if secret]

    def format(self, record: logging.LogRecord) -> str:
        output = super().format(record)
        for secret in self.secrets:
            output = output.replace(secret, "[redacted]")
        return output


class ReadyServer(uvicorn.Server):
    """Signal readiness only after the application lifespan and socket start."""

    def __init__(self, config: uvicorn.Config):
        super().__init__(config)
        self.ready = asyncio.Event()

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        try:
            await super().startup(sockets)
        except SystemExit:
            # Uvicorn calls sys.exit on lifespan failure; in an asyncio task it
            # can abort loop cleanup and strand parent-pipe reader threads.
            raise RuntimeError("Backend startup failed") from None
        if self.started:
            self.ready.set()


def configure_logs(settings: Settings) -> None:
    secrets = [
        settings.internal_token.get_secret_value(),
        settings.public_token.get_secret_value(),
        settings.database_url or "",
        settings.qdrant_api_key.get_secret_value() if settings.qdrant_api_key else "",
        settings.neo4j_password.get_secret_value() if settings.neo4j_password else "",
        settings.embedding_key.get_secret_value() if settings.embedding_key else "",
    ]
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(PrivateFormatter(secrets))
    logging.basicConfig(level=logging.WARNING, handlers=[handler], force=True)
    logging.getLogger("uvicorn.access").disabled = True


async def serve(settings: Settings, port: int) -> int:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener.bind(("127.0.0.1", port))
        listener.listen(128)
        listener.setblocking(False)
        settings.gateway_origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
        server = ReadyServer(
            uvicorn.Config(
                create_app(settings),
                host="127.0.0.1",
                port=listener.getsockname()[1],
                log_config=None,
                log_level="warning",
                access_log=False,
                proxy_headers=False,
                server_header=False,
                timeout_graceful_shutdown=5,
                lifespan="on",
            )
        )
        loop = asyncio.get_running_loop()

        def stop_server() -> None:
            server.should_exit = True

        def watch_parent() -> None:
            try:
                # A daemon must never own BufferedReader's lock at interpreter
                # shutdown. The startup line is complete; the pipe stays open
                # until the supervisor exits and needs no further parsing.
                while os.read(sys.stdin.fileno(), 1):
                    pass
            except OSError:
                pass
            finally:
                try:
                    loop.call_soon_threadsafe(stop_server)
                except RuntimeError:
                    pass

        threading.Thread(target=watch_parent, name="cagent-parent-pipe", daemon=True).start()
        task = asyncio.create_task(server.serve(sockets=[listener]))
        ready_task = asyncio.create_task(server.ready.wait())
        await asyncio.wait({ready_task, task}, return_when=asyncio.FIRST_COMPLETED)
        ready_task.cancel()
        if server.started and not server.should_exit:
            print(
                json.dumps(
                    {
                        "kind": "ready",
                        "origin": settings.gateway_origin,
                        "pid": os.getpid(),
                        "engine": "fastapi-langgraph",
                    },
                    separators=(",", ":"),
                ),
                flush=True,
            )
        await task
        return 0 if server.started else 1
    finally:
        listener.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="CAgent local FastAPI service")
    parser.add_argument("--config-stdin", action="store_true", required=True)
    parser.add_argument("--port", type=int, default=0)
    options = parser.parse_args()
    if not 0 <= options.port <= 65535:
        print("CAgent backend: invalid port", file=sys.stderr)
        return 2
    try:
        raw = sys.stdin.buffer.readline(16 * 1024 + 1)
        if len(raw) > 16 * 1024 or not raw.endswith(b"\n"):
            raise ValueError
        config = json.loads(raw)
        if not isinstance(config, dict):
            raise ValueError
        settings = Settings.from_launch(config)
    except (ValueError, TypeError):
        print("CAgent backend: invalid launch configuration", file=sys.stderr)
        return 2
    configure_logs(settings)
    try:
        if sys.platform == "win32":
            # Initialize NumPy's native DLLs on the main thread. Loading them for the first
            # time inside an AnyIO request worker can block Windows DLL initialization.
            import numpy  # noqa: F401

        return asyncio.run(serve(settings, options.port))
    except KeyboardInterrupt:
        return 0
    except Exception:
        # Configuration and library exceptions can embed credentials. The parent
        # receives a stable diagnostic instead of raw exceptions or tracebacks.
        print("CAgent backend: startup or shutdown failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
