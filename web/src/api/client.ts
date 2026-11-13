import type {
  BenchmarkData,
  CircuitsSnapshot,
  CompletionResult,
  EngineFullStats,
  EvalReport,
  GraphSnapshot,
} from "../types/aegis";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const aegisApi = {
  health: () => fetchJson<{ status: string }>("/api/health"),
  stats: () => fetchJson<EngineFullStats>("/api/stats"),
  graph: () => fetchJson<GraphSnapshot>("/api/graph?max_nodes=128"),
  benchmarks: () => fetchJson<BenchmarkData>("/api/benchmarks"),
  latestEval: () => fetchJson<EvalReport>("/api/evals/latest"),
  runEval: () => fetchJson<EvalReport>("/api/evals/run", { method: "POST" }),
  complete: (body: { prompt: string; tenant_id?: string; bypass_cache?: boolean; json_mode?: boolean }) =>
    fetchJson<CompletionResult>("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  setChaos: (provider: "primary" | "fallback", mode: string) =>
    fetchJson<{ circuits: CircuitsSnapshot }>("/api/chaos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, mode }),
    }),
  resetCircuits: () =>
    fetchJson<{ circuits: CircuitsSnapshot }>("/api/circuits/reset", { method: "POST" }),
};
