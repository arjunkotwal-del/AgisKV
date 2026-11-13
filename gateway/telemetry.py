from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import WebSocket


class TelemetryStore:
    """Thread-safe SQLite WAL persistence for trace waterfalls, circuit transitions, and eval runs."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL;")
            cur.execute("PRAGMA synchronous=NORMAL;")
            cur.execute("PRAGMA busy_timeout=5000;")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS traces (
                    trace_id TEXT PRIMARY KEY,
                    created_at REAL NOT NULL,
                    tenant_id TEXT NOT NULL,
                    prompt_preview TEXT NOT NULL,
                    guardrail_action TEXT NOT NULL,
                    cache_hit INTEGER NOT NULL,
                    similarity REAL NOT NULL,
                    route_used TEXT NOT NULL,
                    circuit_state TEXT NOT NULL,
                    status_code INTEGER NOT NULL,
                    total_ms REAL NOT NULL,
                    cpp_guardrail_us REAL NOT NULL,
                    cpp_hnsw_us REAL NOT NULL,
                    tokens_saved INTEGER NOT NULL,
                    cost_saved_usd REAL NOT NULL,
                    spans_json TEXT NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS circuit_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at REAL NOT NULL,
                    provider TEXT NOT NULL,
                    from_state TEXT NOT NULL,
                    to_state TEXT NOT NULL,
                    reason TEXT NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS eval_runs (
                    run_id TEXT PRIMARY KEY,
                    created_at REAL NOT NULL,
                    suite_size INTEGER NOT NULL,
                    primary_pass_rate REAL NOT NULL,
                    fallback_pass_rate REAL NOT NULL,
                    mean_similarity REAL NOT NULL,
                    mean_latency_ms REAL NOT NULL,
                    cost_reduction_pct REAL NOT NULL,
                    results_json TEXT NOT NULL
                )
                """
            )
            self._conn.commit()

    def record_trace(self, trace: dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO traces (
                    trace_id, created_at, tenant_id, prompt_preview, guardrail_action,
                    cache_hit, similarity, route_used, circuit_state, status_code,
                    total_ms, cpp_guardrail_us, cpp_hnsw_us, tokens_saved,
                    cost_saved_usd, spans_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trace["trace_id"],
                    trace["created_at"],
                    trace["tenant_id"],
                    trace["prompt_preview"],
                    trace["guardrail_action"],
                    1 if trace["cache_hit"] else 0,
                    float(trace["similarity"]),
                    trace["route_used"],
                    trace["circuit_state"],
                    int(trace["status_code"]),
                    float(trace["total_ms"]),
                    float(trace["cpp_guardrail_us"]),
                    float(trace["cpp_hnsw_us"]),
                    int(trace["tokens_saved"]),
                    float(trace["cost_saved_usd"]),
                    json.dumps(trace["spans"]),
                ),
            )
            self._conn.commit()

    def record_circuit_event(self, provider: str, from_state: str, to_state: str, reason: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO circuit_events (created_at, provider, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?)",
                (time.time(), provider, from_state, to_state, reason),
            )
            self._conn.commit()

    def record_eval_run(self, run: dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO eval_runs (
                    run_id, created_at, suite_size, primary_pass_rate, fallback_pass_rate,
                    mean_similarity, mean_latency_ms, cost_reduction_pct, results_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run["run_id"],
                    run["created_at"],
                    run["suite_size"],
                    run["primary_pass_rate"],
                    run["fallback_pass_rate"],
                    run["mean_similarity"],
                    run["mean_latency_ms"],
                    run["cost_reduction_pct"],
                    json.dumps(run["cases"]),
                ),
            )
            self._conn.commit()

    def recent_traces(self, limit: int = 30) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM traces ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            item["cache_hit"] = bool(item["cache_hit"])
            item["spans"] = json.loads(item.pop("spans_json"))
            out.append(item)
        return out

    def recent_circuit_events(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM circuit_events ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def latest_eval_run(self) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["cases"] = json.loads(d.pop("results_json"))
        return d

    def aggregate_summary(self) -> dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT
                    COUNT(*) as total_requests,
                    COALESCE(SUM(cache_hit), 0) as cache_hits,
                    COALESCE(AVG(total_ms), 0.0) as avg_total_ms,
                    COALESCE(AVG(cpp_hnsw_us), 0.0) as avg_hnsw_us,
                    COALESCE(AVG(cpp_guardrail_us), 0.0) as avg_guardrail_us,
                    COALESCE(SUM(tokens_saved), 0) as total_tokens_saved,
                    COALESCE(SUM(cost_saved_usd), 0.0) as total_cost_saved_usd
                FROM traces
                """
            ).fetchone()
        d = dict(row)
        total = d["total_requests"] or 0
        d["cache_hit_rate_pct"] = round((100.0 * d["cache_hits"] / total) if total else 0.0, 2)
        d["avg_total_ms"] = round(float(d["avg_total_ms"]), 2)
        d["avg_hnsw_us"] = round(float(d["avg_hnsw_us"]), 2)
        d["avg_guardrail_us"] = round(float(d["avg_guardrail_us"]), 2)
        d["total_cost_saved_usd"] = round(float(d["total_cost_saved_usd"]), 5)
        return d

    def close(self) -> None:
        with self._lock:
            self._conn.close()


class TelemetryBroadcaster:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = threading.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, event: dict[str, Any]) -> None:
        with self._lock:
            clients = list(self._clients)
        if not clients:
            return
        payload = json.dumps(event)
        stale: list[WebSocket] = []
        for ws in clients:
            try:
                await ws.send_text(payload)
            except Exception:
                stale.append(ws)
        if stale:
            with self._lock:
                for ws in stale:
                    self._clients.discard(ws)
