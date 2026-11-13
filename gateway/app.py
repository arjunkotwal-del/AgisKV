from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from evals.run_eval import run_evaluation
from gateway.service import AegisService
from gateway.upstream import ChaosMode


class CompletionRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=16000)
    tenant_id: str = Field(default="demo-tenant", max_length=64)
    bypass_cache: bool = False
    json_mode: bool = False
    stream: bool = False
    threshold: float | None = Field(default=None, ge=0.1, le=0.999)


class ChaosRequest(BaseModel):
    provider: Literal["primary", "fallback"] = "primary"
    mode: ChaosMode = "healthy"


class SeedRequest(BaseModel):
    prompt: str = Field(..., min_length=3)
    answer: str = Field(..., min_length=3)


service: AegisService | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global service
    service = AegisService()
    await service.seed_default_knowledge()
    # Pre-run one baseline eval if none recorded yet so dashboard & 3D lab start populated
    if service.telemetry.latest_eval_run() is None:
        await run_evaluation(service=service, persist_to_service=True)
    yield
    if service is not None:
        service.close()
        service = None


app = FastAPI(
    title="AegisKV AI Gateway & C++20 Semantic Cache",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _svc() -> AegisService:
    if service is None:
        raise HTTPException(status_code=503, detail="AegisService initializing")
    return service


@app.get("/api/health")
async def health() -> dict:
    s = _svc()
    return {"status": "ok", "engine_stats": s.cpp.stats()}


@app.post("/v1/chat/completions")
async def chat_completions(req: CompletionRequest):
    s = _svc()
    result = await s.process_completion(
        prompt=req.prompt,
        tenant_id=req.tenant_id,
        bypass_cache=req.bypass_cache,
        json_mode=req.json_mode,
        threshold=req.threshold,
    )

    if not req.stream:
        return result

    async def sse_gen():
        meta = {k: v for k, v in result.items() if k != "answer"}
        yield f"event: metadata\ndata: {json.dumps(meta)}\n\n"
        words = result.get("answer", "").split(" ")
        for idx, word in enumerate(words):
            chunk = word + (" " if idx + 1 < len(words) else "")
            yield f"event: delta\ndata: {json.dumps({'delta': chunk})}\n\n"
            await asyncio.sleep(0.015)
        yield f"event: done\ndata: {json.dumps({'trace_id': result['trace_id']})}\n\n"

    return StreamingResponse(sse_gen(), media_type="text/event-stream")


@app.get("/api/stats")
async def get_stats():
    return _svc().full_stats()


@app.get("/api/graph")
async def get_graph(max_nodes: int = 128):
    return _svc().cpp.graph_snapshot(max_nodes=max_nodes)


@app.get("/api/traces")
async def get_traces(limit: int = 25):
    return {"traces": _svc().telemetry.recent_traces(limit=limit)}


@app.post("/api/chaos")
async def set_chaos(req: ChaosRequest):
    circuits = _svc().set_chaos_mode(req.provider, req.mode)
    await _svc().broadcaster.broadcast({"type": "circuits", "circuits": circuits})
    return {"circuits": circuits}


@app.post("/api/circuits/reset")
async def reset_circuits():
    circuits = _svc().reset_circuits()
    await _svc().broadcaster.broadcast({"type": "circuits", "circuits": circuits})
    return {"circuits": circuits}


@app.post("/api/cache/clear")
async def clear_cache():
    _svc().cpp.cache_clear()
    return {"cleared": True}


@app.post("/api/cache/seed")
async def reseed_cache():
    count = await _svc().seed_default_knowledge()
    return {"seeded": count, "graph": _svc().cpp.graph_snapshot(128)}


@app.post("/api/evals/run")
async def trigger_eval():
    return await run_evaluation(service=_svc(), persist_to_service=True)


@app.get("/api/evals/latest")
async def latest_eval():
    run = _svc().telemetry.latest_eval_run()
    if not run:
        run = await run_evaluation(service=_svc(), persist_to_service=True)
    return run


@app.get("/api/benchmarks")
async def get_benchmarks():
    return _svc().load_benchmarks()


@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    s = _svc()
    await s.broadcaster.connect(ws)
    try:
        await ws.send_text(json.dumps({"type": "snapshot", "stats": s.full_stats()}))
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        await s.broadcaster.disconnect(ws)
    except Exception:
        await s.broadcaster.disconnect(ws)


# Serve production React/Three.js build if available
_DIST_DIR = Path(__file__).resolve().parent.parent / "web" / "dist"
if _DIST_DIR.exists():
    assets_dir = _DIST_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        candidate = _DIST_DIR / full_path
        if full_path and candidate.exists() and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(_DIST_DIR / "index.html"))
