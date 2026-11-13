# AegisKV — C++20 HNSW Semantic Cache, Deterministic Guardrails & Fault-Tolerant AI Gateway

Built as a production-grade Systems + AI Infrastructure showcase featuring a compiled **C++20 shared engine** (16-shard thread-safe LRU + multi-layer HNSW vector index + deterministic Luhn/entropy/injection guardrail scanner + token bucket rate limiter), a **Python FastAPI** circuit-breaking control plane with **SQLite WAL** trace waterfalls, an automated **15-case Golden Eval Harness**, and an interactive **3D WebGL Architecture Workbench** built in React Three Fiber & TypeScript.

## Architecture

```text
Incoming Prompt ──▶ [C++20 Guardrail Scanner] ──(BLOCK 403 / REDACT PII)
                            │
                            ▼
                    [C++20 Token Bucket] ──────(HTTP 429 Burst Limit)
                            │
                            ▼
                 [Subword/OpenAI Embedder]
                            │
                            ▼
             [C++20 16-Shard HNSW Vector Cache] ──(HIT < 0.1ms @ 10k vecs)
                            │ MISS
                            ▼
          [Sliding-Window 3-State Circuit Breaker]
                 ├── CLOSED ──▶ Primary Model (Retries + Jitter)
                 └── OPEN ────▶ Fallback Model ──▶ Golden Drift Eval Parity
                            │
                            ▼
            [SQLite WAL Spans + Live WebSocket + 3D Rig]
```

## Measured Benchmarks (MSVC 19.44 `/O2 /std:c++20`, 256-dim float32)

| Index Size (`N`) | HNSW p50 Latency | Brute-Force p50 | Speedup | Recall@1 |
|---:|---:|---:|---:|---:|
| 500 | 35.2 us | 24.9 us | 0.71x | 100.0% |
| 2,000 | 63.4 us | 106.3 us | 1.68x | 100.0% |
| 5,000 | 80.3 us | 270.8 us | 3.37x | 100.0% |
| 10,000 | 96.9 us | 590.4 us | **6.09x** | **99.6%** |

- **Guardrail Throughput (5,000 scans):** `76.6 us` p50, `103.9 us` p95 (**12,421 scans/sec**)
- **Golden Eval Suite (15 cases):** **100.0%** Primary / **100.0%** Fallback parity, `0.9256` mean cosine similarity, **92.02%** token cost reduction on fallback routes.

## Quick Start (Windows)

```powershell
# 1. Build C++20 engine, run native tests & benchmarks
powershell -ExecutionPolicy Bypass -File cpp_core/build.ps1
.\cpp_core\build\aegis_tests.exe
.\cpp_core\build\aegis_bench.exe cpp_core/build/bench_results.json

# 2. Run Python integration tests & golden evals
.\.venv\Scripts\python.exe -m pytest -v
.\.venv\Scripts\python.exe -m evals.run_eval

# 3. Launch full stack + 3D interactive showcase at http://127.0.0.1:8000
powershell -ExecutionPolicy Bypass -File start.ps1
```

## Docker (Linux / Multi-Stage Build)

```bash
docker compose up --build
```
