"""
Thin HTTP wrapper around mempalace's MCP server.

Exposes mempalace's handle_request over HTTP so it can run as a standalone
container (Docker Compose / Podman pod) instead of requiring stdio transport.

Usage:
    python serve_http.py                    # defaults: 0.0.0.0:8080, /mcp
    MEMPALACE_PORT=9090 python serve_http.py

The paperclip server connects with:
    MEMPALACE_URL=http://mempalace:8080/mcp
"""

import asyncio
import os
import json
import logging
import threading

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from mempalace.mcp_server import handle_request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger("mempalace-http")

PORT = int(os.environ.get("MEMPALACE_PORT", "8080"))
PATH = os.environ.get("MEMPALACE_PATH", "/mcp")

# mempalace uses a global SQLite connection (knowledge_graph.py) created with
# check_same_thread=False.  Concurrent handle_request calls from the thread
# pool would hit the same connection from different threads, risking data
# corruption.  Serialize all calls through a single lock so only one request
# touches SQLite (and the shared ChromaDB client) at a time.
_request_lock = threading.Lock()


def _locked_handle_request(body: dict) -> dict | None:
    with _request_lock:
        return handle_request(body)


async def mcp_endpoint(request: Request) -> Response:
    """Accept a JSON-RPC request and return the response."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}},
            status_code=400,
        )

    # handle_request is synchronous (blocking ChromaDB I/O under the hood),
    # so we run it in a thread pool to avoid blocking the event loop.
    # Access is serialized via _request_lock to prevent thread-unsafe SQLite
    # and ChromaDB global state corruption from concurrent requests.
    response = await asyncio.to_thread(_locked_handle_request, body)
    if response is None:
        # Notification — no response expected
        return Response(status_code=204)

    return JSONResponse(response)


async def health(request: Request) -> Response:
    return JSONResponse({"status": "ok"})


app = Starlette(
    routes=[
        Route(PATH, mcp_endpoint, methods=["POST"]),
        Route("/health", health, methods=["GET"]),
    ],
)


if __name__ == "__main__":
    import uvicorn

    logger.info(f"Starting mempalace HTTP server on 0.0.0.0:{PORT}{PATH}")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
