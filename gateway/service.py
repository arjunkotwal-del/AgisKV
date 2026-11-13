from __future__ import annotations

import asyncio
import json
import random
import time
import uuid
from pathlib import Path
from typing import Any

from gateway.circuit_breaker import CircuitEvent, SlidingWindowCircuitBreaker
from gateway.cpp_bridge import CppCoreBridge
from gateway.embeddings import SemanticEmbedder
from gateway.telemetry import TelemetryBroadcaster, TelemetryStore
from gateway.upstream import ChaosMode, UpstreamError, UpstreamResponse, UpstreamRouterAdapter


SEED_KNOWLEDGE: list[tuple[str, str]] = [
    (
        "How do I safely restart a crashing Kubernetes pod without downtime?",
        "Inspect pod events with `kubectl describe pod <name>`, verify liveness/readiness probes, and perform a zero-downtime `kubectl rollout restart deployment/<name>`.",
    ),
    (
        "How does Python's Global Interpreter Lock work with C++ ctypes calls?",
        "CPython's GIL serializes bytecode execution per process, but calling a C++20 shared library through `ctypes.CDLL` automatically releases the GIL so native HNSW and guardrail threads execute concurrently across CPU cores.",
    ),
    (
        "Summarize PostgreSQL MVCC vacuum tuning for high-write SaaS tables.",
        "Lower `autovacuum_vacuum_scale_factor` to 0.02 on churn-heavy tables, increase `autovacuum_vacuum_cost_limit`, and watch `pg_stat_user_tables.n_dead_tup` to keep B-tree index bloat flat.",
    ),
    (
        "Explain how HNSW vector index search narrows down nearest neighbors.",
        "HNSW constructs a multi-layer proximity graph: sparse upper layers act as express highways for greedy descent into Layer 0, where bounded beam search (`ef_search`) finds approximate nearest neighbors in O(log N) hops.",
    ),
    (
        "How does a 3-state circuit breaker prevent cascading upstream outages?",
        "Tracking a sliding window of upstream error rates transitions the breaker from CLOSED to OPEN when failures spike, immediately routing traffic to a fallback model until cooldown probes succeed in HALF_OPEN.",
    ),
    (
        "Why does SQLite WAL mode avoid reader-writer lock contention?",
        "Write-Ahead Logging appends dirty pages to a `-wal` file rather than mutating the main `.db` in place, allowing concurrent async readers to observe consistent snapshots without blocking writers.",
    ),
    (
        "How do token-bucket rate limiters handle bursty tenant traffic?",
        "Each tenant bucket holds up to `capacity` tokens and refills continuously at `refill_rate` per second, permitting bounded short bursts while smoothly enforcing steady-state QPS.",
    ),
    (
        "How does AegisKV scrub PII and secrets before calling external LLM providers?",
        "A deterministic C++20 scanner evaluates Luhn mod-10 card checksums, regex credential patterns, and Shannon token entropy in <100 microseconds, redacting matches before vectors or prompts leave the gateway.",
    ),
]


class AegisService:
    """Core orchestrator connecting the C++20 engine, semantic embedder, circuit breakers, and telemetry."""

    def __init__(
        self,
        db_path: str | Path | None = None,
        vector_dim: int = 256,
        cache_threshold: float = 0.70,
        rate_limit_capacity: float = 40.0,
        rate_limit_refill_per_sec: float = 12.0,
        cooldown_sec: float = 10.0,
    ) -> None:
        base_dir = Path(__file__).resolve().parent.parent
        self.db_path = Path(db_path) if db_path else (base_dir / "data" / "aegis_telemetry.db")
        self.bench_path = base_dir / "cpp_core" / "build" / "bench_results.json"
        self.cache_threshold = cache_threshold

        self.cpp = CppCoreBridge(
            vector_dim=vector_dim,
            max_entries=10000,
            hnsw_m=16,
            ef_construction=64,
            ef_search=32,
            default_ttl_sec=3600,
            rate_limit_capacity=rate_limit_capacity,
            rate_limit_refill_per_sec=rate_limit_refill_per_sec,
        )
        self.embedder = SemanticEmbedder(dim=vector_dim)
        self.upstream = UpstreamRouterAdapter()
        self.telemetry = TelemetryStore(self.db_path)
        self.broadcaster = TelemetryBroadcaster()

        def _on_circuit_evt(evt: CircuitEvent) -> None:
            self.telemetry.record_circuit_event(
                evt.provider, evt.from_state, evt.to_state, evt.reason
            )

        self.primary_cb = SlidingWindowCircuitBreaker(
            provider="primary",
            window_size=8,
            failure_rate_threshold=0.5,
            consecutive_failures_trip=2,
            cooldown_sec=cooldown_sec,
            half_open_success_required=2,
            on_transition=_on_circuit_evt,
        )
        self.fallback_cb = SlidingWindowCircuitBreaker(
            provider="fallback",
            window_size=8,
            failure_rate_threshold=0.6,
            consecutive_failures_trip=3,
            cooldown_sec=cooldown_sec,
            half_open_success_required=1,
            on_transition=_on_circuit_evt,
        )

    async def seed_default_knowledge(self) -> int:
        inserted = 0
        for prompt, answer in SEED_KNOWLEDGE:
            vec = await self.embedder.embed(prompt)
            payload = {
                "answer": answer,
                "model": self.upstream.primary_model,
                "prompt_tokens": max(8, len(prompt.split()) * 4 // 3),
                "completion_tokens": max(16, len(answer.split()) * 4 // 3),
                "source": "seed-cluster",
            }
            eid = self.cpp.cache_upsert(prompt, vec, payload, ttl_sec=3600)
            if eid >= 0:
                inserted += 1
        return inserted

    async def _invoke_with_retries(
        self, provider: str, cb: SlidingWindowCircuitBreaker, prompt: str, json_mode: bool, max_attempts: int = 2
    ) -> UpstreamResponse:
        last_err: Exception | None = None
        for attempt in range(max_attempts):
            if not cb.allow_request():
                raise UpstreamError(503, f"Circuit OPEN for {provider}", retryable=False)
            try:
                resp = await self.upstream.invoke(provider, prompt, json_mode=json_mode)
                cb.record_success()
                return resp
            except UpstreamError as exc:
                last_err = exc
                cb.record_failure(f"HTTP {exc.status_code}")
                if not exc.retryable or attempt + 1 >= max_attempts or not cb.allow_request():
                    break
                # Exponential backoff with full jitter
                base = 0.04 * (2 ** attempt)
                await asyncio.sleep(random.uniform(0.01, base))
        assert last_err is not None
        raise last_err

    async def process_completion(
        self,
        prompt: str,
        tenant_id: str = "demo-tenant",
        bypass_cache: bool = False,
        json_mode: bool = False,
        threshold: float | None = None,
    ) -> dict[str, Any]:
        trace_id = f"tr_{uuid.uuid4().hex[:12]}"
        req_t0 = time.perf_counter()
        spans: list[dict[str, Any]] = []
        eff_threshold = threshold if threshold is not None else self.cache_threshold

        # 1. Deterministic C++20 Guardrail & PII Scan
        gr = self.cpp.guardrail_scan(prompt)
        spans.append({
            "name": "guardrail.cpp_scan",
            "duration_ms": round(gr.get("scan_us", 0.0) / 1000.0, 3),
            "duration_us": round(gr.get("scan_us", 0.0), 2),
            "status": gr.get("action", "ALLOW"),
            "detail": f"findings={len(gr.get('findings', []))}",
        })

        sanitized_prompt = gr.get("sanitized_text", prompt)
        action = gr.get("action", "ALLOW")

        if action == "BLOCK":
            total_ms = round((time.perf_counter() - req_t0) * 1000.0, 2)
            trace = {
                "trace_id": trace_id,
                "created_at": time.time(),
                "tenant_id": tenant_id,
                "prompt_preview": prompt[:84],
                "guardrail_action": "BLOCK",
                "cache_hit": False,
                "similarity": 0.0,
                "route_used": "guardrail_blocked",
                "circuit_state": self.primary_cb.state.value,
                "status_code": 403,
                "total_ms": total_ms,
                "cpp_guardrail_us": round(gr.get("scan_us", 0.0), 2),
                "cpp_hnsw_us": 0.0,
                "tokens_saved": 0,
                "cost_saved_usd": 0.0,
                "spans": spans,
            }
            self.telemetry.record_trace(trace)
            await self.broadcaster.broadcast({"type": "trace", "trace": trace, "circuits": self.circuits_snapshot()})
            return {
                "trace_id": trace_id,
                "status_code": 403,
                "blocked": True,
                "guardrail": gr,
                "ratelimit": None,
                "cache": {"hit": False, "similarity": 0.0, "hop_trace": []},
                "route_used": "guardrail_blocked",
                "model": "none",
                "answer": "Request blocked by AegisKV deterministic pre-flight guardrail policy.",
                "sanitized_prompt": sanitized_prompt,
                "total_ms": total_ms,
                "spans": spans,
                "circuits": self.circuits_snapshot(),
            }

        # 2. C++20 Token-Bucket Rate Limiter
        rl = self.cpp.ratelimit_allow(tenant_id, 1.0)
        spans.append({
            "name": "ratelimit.token_bucket",
            "duration_ms": 0.02,
            "duration_us": 20.0,
            "status": "ALLOW" if rl.get("allowed", True) else "REJECT",
            "detail": f"remaining={round(rl.get('remaining_tokens', 0.0), 1)}",
        })
        if not rl.get("allowed", True):
            total_ms = round((time.perf_counter() - req_t0) * 1000.0, 2)
            trace = {
                "trace_id": trace_id,
                "created_at": time.time(),
                "tenant_id": tenant_id,
                "prompt_preview": sanitized_prompt[:84],
                "guardrail_action": action,
                "cache_hit": False,
                "similarity": 0.0,
                "route_used": "rate_limited",
                "circuit_state": self.primary_cb.state.value,
                "status_code": 429,
                "total_ms": total_ms,
                "cpp_guardrail_us": round(gr.get("scan_us", 0.0), 2),
                "cpp_hnsw_us": 0.0,
                "tokens_saved": 0,
                "cost_saved_usd": 0.0,
                "spans": spans,
            }
            self.telemetry.record_trace(trace)
            await self.broadcaster.broadcast({"type": "trace", "trace": trace, "circuits": self.circuits_snapshot()})
            return {
                "trace_id": trace_id,
                "status_code": 429,
                "blocked": True,
                "guardrail": gr,
                "ratelimit": rl,
                "cache": {"hit": False, "similarity": 0.0, "hop_trace": []},
                "route_used": "rate_limited",
                "model": "none",
                "answer": f"Tenant '{tenant_id}' exceeded token bucket limit. Retry in {rl.get('retry_after_ms', 0):.0f}ms.",
                "sanitized_prompt": sanitized_prompt,
                "total_ms": total_ms,
                "spans": spans,
                "circuits": self.circuits_snapshot(),
            }

        # 3. Semantic Embedding + C++20 HNSW Cache Search
        emb_t0 = time.perf_counter()
        vec = await self.embedder.embed(sanitized_prompt)
        emb_ms = round((time.perf_counter() - emb_t0) * 1000.0, 3)
        spans.append({
            "name": "embed.encode",
            "duration_ms": emb_ms,
            "duration_us": round(emb_ms * 1000.0, 1),
            "status": "OK",
            "detail": f"provider={self.embedder.provider}, dim={self.embedder.dim}",
        })

        cache_res: dict[str, Any] = {"hit": False, "similarity": 0.0, "search_us": 0.0, "hop_trace": [], "candidates": []}
        if not bypass_cache:
            cache_res = self.cpp.cache_search(vec, threshold=eff_threshold, top_k=3)
            spans.append({
                "name": "cache.cpp_hnsw_search",
                "duration_ms": round(cache_res.get("search_us", 0.0) / 1000.0, 3),
                "duration_us": round(cache_res.get("search_us", 0.0), 2),
                "status": "HIT" if cache_res.get("hit") else "MISS",
                "detail": f"sim={cache_res.get('similarity', 0.0):.3f}, hops={cache_res.get('hops_evaluated', 0)}",
            })

        if cache_res.get("hit") and cache_res.get("payload"):
            payload = cache_res["payload"]
            answer = payload.get("answer", "")
            saved_tokens = int(payload.get("prompt_tokens", 20)) + int(payload.get("completion_tokens", 45))
            saved_cost = round(saved_tokens * 0.0000075, 6)
            total_ms = round((time.perf_counter() - req_t0) * 1000.0, 2)
            trace = {
                "trace_id": trace_id,
                "created_at": time.time(),
                "tenant_id": tenant_id,
                "prompt_preview": sanitized_prompt[:84],
                "guardrail_action": action,
                "cache_hit": True,
                "similarity": round(float(cache_res.get("similarity", 0.0)), 4),
                "route_used": "hnsw_semantic_cache",
                "circuit_state": self.primary_cb.state.value,
                "status_code": 200,
                "total_ms": total_ms,
                "cpp_guardrail_us": round(gr.get("scan_us", 0.0), 2),
                "cpp_hnsw_us": round(cache_res.get("search_us", 0.0), 2),
                "tokens_saved": saved_tokens,
                "cost_saved_usd": saved_cost,
                "spans": spans,
            }
            self.telemetry.record_trace(trace)
            await self.broadcaster.broadcast({"type": "trace", "trace": trace, "circuits": self.circuits_snapshot()})
            return {
                "trace_id": trace_id,
                "status_code": 200,
                "blocked": False,
                "guardrail": gr,
                "ratelimit": rl,
                "cache": cache_res,
                "route_used": "hnsw_semantic_cache",
                "model": payload.get("model", self.upstream.primary_model),
                "answer": answer,
                "sanitized_prompt": sanitized_prompt,
                "tokens_saved": saved_tokens,
                "cost_saved_usd": saved_cost,
                "total_ms": total_ms,
                "spans": spans,
                "circuits": self.circuits_snapshot(),
            }

        # 4. Circuit-Breaking Primary -> Fallback Upstream Routing
        up_resp: UpstreamResponse | None = None
        route_used = "primary"
        try:
            up_t0 = time.perf_counter()
            up_resp = await self._invoke_with_retries("primary", self.primary_cb, sanitized_prompt, json_mode=json_mode)
            spans.append({
                "name": "upstream.primary",
                "duration_ms": round((time.perf_counter() - up_t0) * 1000.0, 2),
                "duration_us": round((time.perf_counter() - up_t0) * 1_000_000.0, 1),
                "status": "OK",
                "detail": f"model={up_resp.model}",
            })
        except UpstreamError as primary_err:
            spans.append({
                "name": "upstream.primary",
                "duration_ms": round((time.perf_counter() - req_t0) * 1000.0, 2),
                "duration_us": 0.0,
                "status": f"ERR_{primary_err.status_code}",
                "detail": str(primary_err),
            })
            route_used = "fallback"
            try:
                fb_t0 = time.perf_counter()
                up_resp = await self._invoke_with_retries("fallback", self.fallback_cb, sanitized_prompt, json_mode=json_mode)
                spans.append({
                    "name": "upstream.fallback",
                    "duration_ms": round((time.perf_counter() - fb_t0) * 1000.0, 2),
                    "duration_us": round((time.perf_counter() - fb_t0) * 1_000_000.0, 1),
                    "status": "OK",
                    "detail": f"model={up_resp.model}",
                })
            except UpstreamError as fb_err:
                total_ms = round((time.perf_counter() - req_t0) * 1000.0, 2)
                trace = {
                    "trace_id": trace_id,
                    "created_at": time.time(),
                    "tenant_id": tenant_id,
                    "prompt_preview": sanitized_prompt[:84],
                    "guardrail_action": action,
                    "cache_hit": False,
                    "similarity": round(float(cache_res.get("similarity", 0.0)), 4),
                    "route_used": "all_upstreams_failed",
                    "circuit_state": self.primary_cb.state.value,
                    "status_code": fb_err.status_code,
                    "total_ms": total_ms,
                    "cpp_guardrail_us": round(gr.get("scan_us", 0.0), 2),
                    "cpp_hnsw_us": round(cache_res.get("search_us", 0.0), 2),
                    "tokens_saved": 0,
                    "cost_saved_usd": 0.0,
                    "spans": spans,
                }
                self.telemetry.record_trace(trace)
                await self.broadcaster.broadcast({"type": "trace", "trace": trace, "circuits": self.circuits_snapshot()})
                return {
                    "trace_id": trace_id,
                    "status_code": 503,
                    "blocked": False,
                    "guardrail": gr,
                    "ratelimit": rl,
                    "cache": cache_res,
                    "route_used": "all_upstreams_failed",
                    "model": "unavailable",
                    "answer": f"Primary & Fallback upstreams failed: {fb_err}",
                    "sanitized_prompt": sanitized_prompt,
                    "total_ms": total_ms,
                    "spans": spans,
                    "circuits": self.circuits_snapshot(),
                }

        assert up_resp is not None

        # 5. Populate C++20 HNSW Semantic Cache on healthy non-corrupted answers
        if not bypass_cache and self.upstream.primary_chaos_mode != "drift_corrupted":
            cache_payload = {
                "answer": up_resp.content,
                "model": up_resp.model,
                "prompt_tokens": up_resp.prompt_tokens,
                "completion_tokens": up_resp.completion_tokens,
                "source": route_used,
            }
            self.cpp.cache_upsert(sanitized_prompt, vec, cache_payload, ttl_sec=3600)
            spans.append({
                "name": "cache.cpp_hnsw_upsert",
                "duration_ms": 0.08,
                "duration_us": 80.0,
                "status": "STORED",
                "detail": "16-shard LRU + HNSW edge link",
            })

        total_ms = round((time.perf_counter() - req_t0) * 1000.0, 2)
        trace = {
            "trace_id": trace_id,
            "created_at": time.time(),
            "tenant_id": tenant_id,
            "prompt_preview": sanitized_prompt[:84],
            "guardrail_action": action,
            "cache_hit": False,
            "similarity": round(float(cache_res.get("similarity", 0.0)), 4),
            "route_used": route_used,
            "circuit_state": self.primary_cb.state.value,
            "status_code": 200,
            "total_ms": total_ms,
            "cpp_guardrail_us": round(gr.get("scan_us", 0.0), 2),
            "cpp_hnsw_us": round(cache_res.get("search_us", 0.0), 2),
            "tokens_saved": 0,
            "cost_saved_usd": 0.0,
            "spans": spans,
        }
        self.telemetry.record_trace(trace)
        await self.broadcaster.broadcast({"type": "trace", "trace": trace, "circuits": self.circuits_snapshot()})

        return {
            "trace_id": trace_id,
            "status_code": 200,
            "blocked": False,
            "guardrail": gr,
            "ratelimit": rl,
            "cache": cache_res,
            "route_used": route_used,
            "model": up_resp.model,
            "answer": up_resp.content,
            "sanitized_prompt": sanitized_prompt,
            "prompt_tokens": up_resp.prompt_tokens,
            "completion_tokens": up_resp.completion_tokens,
            "cost_usd": up_resp.cost_usd,
            "total_ms": total_ms,
            "spans": spans,
            "circuits": self.circuits_snapshot(),
        }

    def set_chaos_mode(self, provider: str, mode: ChaosMode) -> dict[str, Any]:
        if provider == "primary":
            self.upstream.primary_chaos_mode = mode
        elif provider == "fallback":
            self.upstream.fallback_chaos_mode = mode
        return self.circuits_snapshot()

    def reset_circuits(self) -> dict[str, Any]:
        self.upstream.primary_chaos_mode = "healthy"
        self.upstream.fallback_chaos_mode = "healthy"
        self.primary_cb.force_reset()
        self.fallback_cb.force_reset()
        return self.circuits_snapshot()

    def circuits_snapshot(self) -> dict[str, Any]:
        return {
            "primary": {
                **self.primary_cb.snapshot(),
                "chaos_mode": self.upstream.primary_chaos_mode,
                "model": self.upstream.primary_model,
            },
            "fallback": {
                **self.fallback_cb.snapshot(),
                "chaos_mode": self.upstream.fallback_chaos_mode,
                "model": self.upstream.fallback_model,
            },
        }

    def full_stats(self) -> dict[str, Any]:
        return {
            "engine": self.cpp.stats(),
            "telemetry": self.telemetry.aggregate_summary(),
            "circuits": self.circuits_snapshot(),
            "circuit_events": self.telemetry.recent_circuit_events(12),
        }

    def load_benchmarks(self) -> dict[str, Any]:
        if self.bench_path.exists():
            return json.loads(self.bench_path.read_text(encoding="utf-8"))
        return {"vector_dim": 256, "scaling": [], "guardrail": {}}

    def close(self) -> None:
        self.cpp.close()
        self.telemetry.close()
