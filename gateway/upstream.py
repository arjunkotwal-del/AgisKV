from __future__ import annotations

import asyncio
import json
import os
import random
import time
from dataclasses import dataclass
from typing import Literal

import httpx

ChaosMode = Literal["healthy", "rate_limit_429", "outage_503", "latency_spike", "drift_corrupted"]


class UpstreamError(Exception):
    def __init__(self, status_code: int, message: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable


@dataclass
class UpstreamResponse:
    provider: str
    model: str
    content: str
    prompt_tokens: int
    completion_tokens: int
    latency_ms: float
    cost_usd: float


_KNOWLEDGE_ANSWERS: list[tuple[tuple[str, ...], str]] = [
    (
        ("kubernetes", "pod", "restart", "crash"),
        "To safely restart an unhealthy Kubernetes pod without causing downtime, inspect events first via `kubectl describe pod <name>`, then trigger a controlled rollout with `kubectl rollout restart deployment/<deploy>` or delete the single pod so the ReplicaSet schedules a clean replacement.",
    ),
    (
        ("global", "interpreter", "lock", "python"),
        "Python's Global Interpreter Lock (GIL) is a mutex inside CPython ensuring only one thread executes Python bytecode at a time. Calling C/C++ extensions via ctypes (`CDLL`) or PyBind11 with `gil_scoped_release` drops the GIL so multi-core native C++20 threads run concurrently.",
    ),
    (
        ("postgresql", "mvcc", "vacuum", "tuning"),
        "PostgreSQL MVCC keeps dead row tuples after updates/deletes until VACUUM reclaims them. On write-heavy tables, lower `autovacuum_vacuum_scale_factor` (e.g. 0.02), raise `autovacuum_vacuum_cost_limit`, and monitor `n_dead_tup` to prevent transaction ID wraparound and table bloat.",
    ),
    (
        ("hnsw", "vector", "search", "cache"),
        "HNSW builds a multi-layer proximity graph where upper sparse layers act as long-range express highways and Layer 0 holds dense local neighborhoods. Greedy descent from the top entry point narrows the search space in O(log N) hops, delivering sub-millisecond vector lookup at 99%+ recall.",
    ),
    (
        ("circuit", "breaker", "fallback", "outage"),
        "A 3-state Circuit Breaker (CLOSED, OPEN, HALF_OPEN) tracks sliding-window failure rates. When upstream 429/503 faults cross threshold, it trips OPEN to fail-fast and route to a secondary model, then sends bounded HALF_OPEN probes after cooldown to verify recovery.",
    ),
    (
        ("luhn", "entropy", "guardrail", "secret"),
        "Deterministic pre-flight guardrails scrub leaked credentials in microseconds before external API calls: regex + Luhn mod-10 checksums catch valid payment cards without flagging order IDs, while Shannon entropy analysis (H >= 3.95) detects arbitrary high-entropy bearer secrets.",
    ),
    (
        ("sqlite", "wal", "concurrency", "lock"),
        "Enabling `PRAGMA journal_mode=WAL` in SQLite writes mutations to an append-only write-ahead log instead of locking the main database file, letting concurrent readers proceed without blocking async telemetry writers.",
    ),
]


def _estimate_tokens(text: str) -> int:
    return max(4, len(text.split()) * 4 // 3)


def _synthesize_domain_answer(prompt: str, tier: str, drift_corrupt: bool = False) -> str:
    lower = prompt.lower()
    if "json" in lower and ("extract" in lower or "schema" in lower or "return json" in lower):
        if drift_corrupt:
            return "{ invalid_json_drift: missing_quotes, status: broken "
        payload = {
            "service": "aegis-kv",
            "tier": tier,
            "status": "verified",
            "controls": ["hnsw-cache", "luhn-pii-redaction", "circuit-breaker"],
        }
        return json.dumps(payload)

    for keywords, answer in _KNOWLEDGE_ANSWERS:
        if sum(1 for kw in keywords if kw in lower) >= 2:
            if drift_corrupt:
                return f"[{tier} DRIFT] Unverified truncated response regarding {keywords[0]}..."
            return answer

    if drift_corrupt:
        return "[DRIFT] Incomplete fallback output without requested structure."

    return (
        f"[{tier}] Processed request safely through AegisKV gateway. "
        f"Summary for '{prompt[:72].strip()}': apply deterministic pre-flight validation, "
        f"shard concurrent state cleanly, and measure p95 tail latency under load."
    )


class UpstreamRouterAdapter:
    """Routes inference requests to OpenAI, Ollama, or the built-in Chaos Simulation upstream."""

    def __init__(self) -> None:
        self.primary_chaos_mode: ChaosMode = "healthy"
        self.fallback_chaos_mode: ChaosMode = "healthy"
        self.upstream_mode = os.environ.get("AEGIS_UPSTREAM_MODE", "simulation").lower()
        self.openai_api_key = os.environ.get("OPENAI_API_KEY", "") if self.upstream_mode == "openai" else ""
        self.openai_base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
        self.ollama_url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434") if self.upstream_mode == "ollama" else ""
        self.primary_model = os.environ.get("AEGIS_PRIMARY_MODEL", "gpt-4o")
        self.fallback_model = os.environ.get("AEGIS_FALLBACK_MODEL", "gpt-4o-mini")

    async def invoke(self, provider: str, prompt: str, json_mode: bool = False) -> UpstreamResponse:
        t0 = time.perf_counter()
        mode = self.primary_chaos_mode if provider == "primary" else self.fallback_chaos_mode
        model = self.primary_model if provider == "primary" else self.fallback_model

        # Explicit chaos fault injection takes precedence for deterministic chaos testing
        if mode == "rate_limit_429":
            await asyncio.sleep(0.025)
            raise UpstreamError(429, f"{provider} upstream HTTP 429 Too Many Requests", retryable=True)
        if mode == "outage_503":
            await asyncio.sleep(0.030)
            raise UpstreamError(503, f"{provider} upstream HTTP 503 Service Unavailable", retryable=True)
        if mode == "latency_spike":
            await asyncio.sleep(0.45)

        # Real OpenAI upstream if API key is configured and no chaos fault active
        if self.openai_api_key and mode == "healthy":
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    body: dict = {
                        "model": model,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0.2,
                    }
                    if json_mode:
                        body["response_format"] = {"type": "json_object"}
                    resp = await client.post(
                        f"{self.openai_base_url.rstrip('/')}/chat/completions",
                        headers={"Authorization": f"Bearer {self.openai_api_key}"},
                        json=body,
                    )
                    if resp.status_code in (429, 500, 502, 503, 504):
                        raise UpstreamError(resp.status_code, f"OpenAI HTTP {resp.status_code}", retryable=True)
                    resp.raise_for_status()
                    data = resp.json()
                    content = data["choices"][0]["message"]["content"]
                    usage = data.get("usage", {})
                    pt = int(usage.get("prompt_tokens", _estimate_tokens(prompt)))
                    ct = int(usage.get("completion_tokens", _estimate_tokens(content)))
                    lat = (time.perf_counter() - t0) * 1000.0
                    rate = 0.0000075 if provider == "primary" else 0.0000006
                    return UpstreamResponse(
                        provider=provider,
                        model=model,
                        content=content,
                        prompt_tokens=pt,
                        completion_tokens=ct,
                        latency_ms=round(lat, 2),
                        cost_usd=round((pt + ct) * rate, 6),
                    )
            except UpstreamError:
                raise
            except Exception as exc:
                raise UpstreamError(502, f"OpenAI transport failure: {exc}", retryable=True) from exc

        # Real Ollama upstream if configured
        if self.ollama_url and mode == "healthy":
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    resp = await client.post(
                        f"{self.ollama_url.rstrip('/')}/api/generate",
                        json={"model": os.environ.get("AEGIS_OLLAMA_MODEL", "llama3.2"), "prompt": prompt, "stream": False},
                    )
                    resp.raise_for_status()
                    content = resp.json().get("response", "")
                    lat = (time.perf_counter() - t0) * 1000.0
                    pt = _estimate_tokens(prompt)
                    ct = _estimate_tokens(content)
                    return UpstreamResponse(
                        provider=provider,
                        model=os.environ.get("AEGIS_OLLAMA_MODEL", "llama3.2"),
                        content=content,
                        prompt_tokens=pt,
                        completion_tokens=ct,
                        latency_ms=round(lat, 2),
                        cost_usd=0.0,
                    )
            except Exception as exc:
                raise UpstreamError(503, f"Ollama unreachable: {exc}", retryable=True) from exc

        # Built-in zero-key simulation upstream (simulates realistic primary vs fallback latency & pricing)
        sim_delay = random.uniform(0.055, 0.095) if provider == "primary" else random.uniform(0.028, 0.052)
        await asyncio.sleep(sim_delay)
        content = _synthesize_domain_answer(
            prompt,
            tier=f"{provider}:{model}",
            drift_corrupt=(mode == "drift_corrupted"),
        )
        pt = _estimate_tokens(prompt)
        ct = _estimate_tokens(content)
        lat = (time.perf_counter() - t0) * 1000.0
        rate = 0.0000075 if provider == "primary" else 0.0000006
        return UpstreamResponse(
            provider=provider,
            model=model,
            content=content,
            prompt_tokens=pt,
            completion_tokens=ct,
            latency_ms=round(lat, 2),
            cost_usd=round((pt + ct) * rate, 6),
        )
