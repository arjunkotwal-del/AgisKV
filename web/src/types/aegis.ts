export type GuardrailAction = GuardrailResult["action"];
export type CircuitState = CircuitSnapshot["state"];
export type HopStep = SearchHop;

export interface SpanItem {
  name: string;
  duration_ms: number;
  duration_us: number;
  status: string;
  detail: string;
}

export interface GuardrailFinding {
  rule_id: string;
  category: string;
  severity: string;
  offset: number;
  length: number;
  preview: string;
}

export interface GuardrailResult {
  action: "ALLOW" | "REDACT" | "BLOCK";
  risk_score: number;
  scan_us: number;
  sanitized_text: string;
  findings: GuardrailFinding[];
}

export interface SearchHop {
  node_idx: number;
  level: number;
  similarity: number;
}

export interface CompletionResult {
  trace_id: string;
  status_code: number;
  blocked: boolean;
  guardrail: GuardrailResult;
  ratelimit: {
    allowed: boolean;
    remaining_tokens: number;
    capacity: number;
    refill_per_sec: number;
    retry_after_ms: number;
  } | null;
  cache: {
    hit: boolean;
    similarity: number;
    hops_evaluated?: number;
    search_us?: number;
    hop_trace?: SearchHop[];
    candidates?: Array<{
      entry_id: number;
      node_idx: number;
      similarity: number;
      key_preview: string;
    }>;
  };
  route_used: string;
  model: string;
  answer: string;
  sanitized_prompt: string;
  tokens_saved?: number;
  cost_saved_usd?: number;
  total_ms: number;
  spans: SpanItem[];
  circuits: CircuitsSnapshot;
}

export interface CircuitSnapshot {
  provider: string;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  consecutive_failures: number;
  window_failures: number;
  window_size: number;
  cooldown_remaining_sec: number;
  total_trips: number;
  last_reason: string;
  chaos_mode: "healthy" | "rate_limit_429" | "outage_503" | "latency_spike" | "drift_corrupted";
  model: string;
}

export interface CircuitsSnapshot {
  primary: CircuitSnapshot;
  fallback: CircuitSnapshot;
}

export interface GraphNode {
  node_idx: number;
  entry_id: number;
  shard: number;
  level: number;
  key_preview: string;
  pos: [number, number, number];
}

export interface GraphEdge {
  from: number;
  to: number;
  level: number;
}

export interface GraphSnapshot {
  max_level: number;
  entry_point: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface BenchmarkData {
  vector_dim: number;
  num_queries: number;
  scaling: Array<{
    entries: number;
    insert_total_ms: number;
    hnsw_p50_us: number;
    hnsw_p95_us: number;
    hnsw_p99_us: number;
    brute_p50_us: number;
    brute_p95_us: number;
    speedup: number;
    recall_at_1_pct: number;
  }>;
  guardrail: {
    iterations: number;
    p50_us: number;
    p95_us: number;
    throughput_scans_per_sec: number;
  };
}

export interface EvalCaseResult {
  id: string;
  category: string;
  primary_pass: boolean;
  fallback_pass: boolean;
  similarity: number;
  latency_ms: number;
  detail: string;
}

export interface EvalReport {
  run_id: string;
  created_at: number;
  suite_size: number;
  primary_pass_rate: number;
  fallback_pass_rate: number;
  mean_similarity: number;
  mean_latency_ms: number;
  cost_reduction_pct: number;
  cases: EvalCaseResult[];
}

export interface EngineFullStats {
  engine: {
    cache: {
      vector_dim: number;
      max_entries: number;
      shards: number;
      active_entries: number;
      total_nodes: number;
      tombstones: number;
      hits: number;
      misses: number;
      evictions: number;
      expirations: number;
      avg_search_us: number;
      hnsw_levels: number;
      hnsw_edges: number;
    };
    guardrail: {
      total_scans: number;
      blocks: number;
      redactions: number;
    };
    ratelimit: {
      rejects: number;
    };
  };
  telemetry: {
    total_requests: number;
    cache_hits: number;
    cache_hit_rate_pct: number;
    avg_total_ms: number;
    avg_hnsw_us: number;
    avg_guardrail_us: number;
    total_tokens_saved: number;
    total_cost_saved_usd: number;
  };
  circuits: CircuitsSnapshot;
  circuit_events: Array<{
    id: number;
    created_at: number;
    provider: string;
    from_state: string;
    to_state: string;
    reason: string;
  }>;
}
