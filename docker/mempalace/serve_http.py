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

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from mempalace.mcp_server import handle_request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger("mempalace-http")

PORT = int(os.environ.get("MEMPALACE_PORT", "8080"))
PATH = os.environ.get("MEMPALACE_PATH", "/mcp")


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
    response = await asyncio.to_thread(handle_request, body)
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
