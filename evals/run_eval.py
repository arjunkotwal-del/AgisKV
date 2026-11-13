from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from gateway.service import AegisService


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom <= 1e-8:
        return 0.0
    return float(np.dot(a, b) / denom)


async def run_evaluation(
    service: AegisService | None = None,
    suite_path: str | Path | None = None,
    persist_to_service: bool = True,
) -> dict[str, Any]:
    suite_file = Path(suite_path) if suite_path else (ROOT_DIR / "evals" / "golden_suite.json")
    cases_raw = json.loads(suite_file.read_text(encoding="utf-8"))

    owns_service = False
    tmp_dir_obj = None
    if service is None:
        owns_service = True
        tmp_dir_obj = tempfile.TemporaryDirectory()
        service = AegisService(
            db_path=Path(tmp_dir_obj.name) / "eval_tmp.db",
            rate_limit_capacity=500.0,
            rate_limit_refill_per_sec=100.0,
        )

    # Save chaos modes and restore cleanly after eval
    orig_primary_mode = service.upstream.primary_chaos_mode
    orig_fallback_mode = service.upstream.fallback_chaos_mode

    results: list[dict[str, Any]] = []
    primary_passes = 0
    fallback_passes = 0
    similarities: list[float] = []
    latencies: list[float] = []
    primary_cost_sum = 0.0
    fallback_cost_sum = 0.0

    try:
        for idx, case in enumerate(cases_raw):
            cid = case["id"]
            cat = case["category"]
            tenant = f"eval-suite-{idx}"

            if cat == "semantic_cache_pair":
                service.upstream.primary_chaos_mode = "healthy"
                service.primary_cb.force_reset()
                seed_res = await service.process_completion(case["seed_prompt"], tenant_id=tenant)
                hit_res = await service.process_completion(case["query_prompt"], tenant_id=tenant)
                passed = bool(hit_res["cache"].get("hit", False)) and hit_res["route_used"] == "hnsw_semantic_cache"
                sim = float(hit_res["cache"].get("similarity", 0.0))
                if passed:
                    primary_passes += 1
                    fallback_passes += 1
                similarities.append(sim)
                latencies.append(float(hit_res["total_ms"]))
                results.append({
                    "id": cid,
                    "category": cat,
                    "primary_pass": passed,
                    "fallback_pass": passed,
                    "similarity": round(sim, 4),
                    "latency_ms": float(hit_res["total_ms"]),
                    "detail": f"HNSW cache hit={passed}, sim={sim:.3f}, search_us={hit_res['cache'].get('search_us', 0.0):.1f}us",
                })
                continue

            # Run Primary (healthy, bypass cache to measure true model behavior)
            service.upstream.primary_chaos_mode = "healthy"
            service.upstream.fallback_chaos_mode = "healthy"
            service.primary_cb.force_reset()
            service.fallback_cb.force_reset()

            json_mode = bool(case.get("json_mode", False))
            p_res = await service.process_completion(
                case["prompt"], tenant_id=f"{tenant}-p", bypass_cache=True, json_mode=json_mode
            )

            # Force Fallback route via primary outage mode to measure drift vs primary
            service.upstream.primary_chaos_mode = "outage_503"
            f_res = await service.process_completion(
                case["prompt"], tenant_id=f"{tenant}-f", bypass_cache=True, json_mode=json_mode
            )
            service.upstream.primary_chaos_mode = "healthy"
            service.primary_cb.force_reset()

            def evaluate_single(resp: dict[str, Any]) -> bool:
                action = resp["guardrail"].get("action", "ALLOW")
                if action != case.get("expected_action", "ALLOW"):
                    return False
                for bad in case.get("forbidden_substrings", []):
                    if action == "REDACT" and bad.lower() in resp.get("sanitized_prompt", "").lower():
                        return False
                    if bad.lower() in resp.get("answer", "").lower():
                        return False
                if cat == "json_schema":
                    try:
                        parsed = json.loads(resp["answer"])
                        return all(k in parsed for k in case.get("required_keys", []))
                    except Exception:
                        return False
                if cat == "technical_qa":
                    ans_low = resp["answer"].lower()
                    kws = case.get("required_keywords", [])
                    matches = sum(1 for k in kws if k in ans_low)
                    return matches >= max(1, len(kws) - 1)
                return True

            p_ok = evaluate_single(p_res)
            f_ok = evaluate_single(f_res)
            if p_ok:
                primary_passes += 1
            if f_ok:
                fallback_passes += 1

            vec_p = service.embedder.embed_sync(p_res["answer"])
            vec_f = service.embedder.embed_sync(f_res["answer"])
            sim = _cosine(vec_p, vec_f)
            similarities.append(sim)
            latencies.append(float(f_res["total_ms"]))
            primary_cost_sum += float(p_res.get("cost_usd", 0.0))
            fallback_cost_sum += float(f_res.get("cost_usd", 0.0))

            results.append({
                "id": cid,
                "category": cat,
                "primary_pass": p_ok,
                "fallback_pass": f_ok,
                "similarity": round(sim, 4),
                "latency_ms": float(f_res["total_ms"]),
                "detail": f"action={p_res['guardrail'].get('action')}, primary_ok={p_ok}, fallback_ok={f_ok}",
            })
    finally:
        service.upstream.primary_chaos_mode = orig_primary_mode
        service.upstream.fallback_chaos_mode = orig_fallback_mode
        service.primary_cb.force_reset()
        service.fallback_cb.force_reset()

    total = len(cases_raw)
    cost_red = (
        round(100.0 * (primary_cost_sum - fallback_cost_sum) / primary_cost_sum, 2)
        if primary_cost_sum > 0
        else 0.0
    )
    summary = {
        "run_id": f"eval_{uuid.uuid4().hex[:10]}",
        "created_at": time.time(),
        "suite_size": total,
        "primary_pass_rate": round(100.0 * primary_passes / total, 2),
        "fallback_pass_rate": round(100.0 * fallback_passes / total, 2),
        "mean_similarity": round(sum(similarities) / len(similarities), 4) if similarities else 0.0,
        "mean_latency_ms": round(sum(latencies) / len(latencies), 2) if latencies else 0.0,
        "cost_reduction_pct": cost_red,
        "cases": results,
    }

    if persist_to_service:
        service.telemetry.record_eval_run(summary)
    if owns_service:
        service.close()
        if tmp_dir_obj is not None:
            tmp_dir_obj.cleanup()
    return summary


if __name__ == "__main__":
    out = asyncio.run(run_evaluation(persist_to_service=False))
    out_file = ROOT_DIR / "evals" / "latest_eval.json"
    out_file.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(
        f"Eval Run {out['run_id']}: {out['suite_size']} cases | "
        f"Primary={out['primary_pass_rate']}% | Fallback={out['fallback_pass_rate']}% | "
        f"Mean Sim={out['mean_similarity']} | Cost Reduction={out['cost_reduction_pct']}%"
    )
