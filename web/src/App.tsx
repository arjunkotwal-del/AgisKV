import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { aegisApi } from "./api/client";
import { BrandIcon } from "./components/BrandIcon";
import { AegisCoreRig3D } from "./components/three/AegisCoreRig3D";

const BreakerManifold3D = lazy(() =>
  import("./components/three/BreakerManifold3D").then((m) => ({ default: m.BreakerManifold3D }))
);
const GuardrailSieve3D = lazy(() =>
  import("./components/three/GuardrailSieve3D").then((m) => ({ default: m.GuardrailSieve3D }))
);
const HnswCrystal3D = lazy(() =>
  import("./components/three/HnswCrystal3D").then((m) => ({ default: m.HnswCrystal3D }))
);
import {
  BUILD_STAGES,
  FALLBACK_GRAPH,
  POSTMORTEMS,
  SANDBOX_PRESETS,
  VERIFIED_BENCHMARKS,
  VERIFIED_EVALS,
  runDemoSandboxFallback,
} from "./data/storyData";
import type {
  BenchmarkData,
  CircuitsSnapshot,
  CompletionResult,
  EvalReport,
  GraphNode,
  GraphSnapshot,
  GuardrailAction,
} from "./types/aegis";

type SubTabId = "hnsw" | "guardrail" | "breaker" | "rig";

const BLADE_NAMES = [
  "Floor 1 · Safety check",
  "Floor 2 · Smart memory",
  "Floor 3 · Backup switch",
  "Floor 4 · Fast reply",
];

const HUB_DIAGRAM_SPEC = JSON.stringify({
  layout: "hub",
  alt: "AegisKV connects C++20 HNSW search, Python 3.12 ABI, FastAPI routes, SQLite WAL storage, OpenAI upstreams, and the React console.",
  center: { label: "AegisKV", icon: "text:AK" },
  spokes: [
    { label: "C++20 HNSW", icon: "c-plusplus" },
    { label: "Python ABI", icon: "python" },
    { label: "FastAPI", icon: "fastapi" },
    { label: "SQLite WAL", icon: "sqlite" },
    { label: "Upstream", icon: "openai" },
    { label: "Console", icon: "react" },
  ],
});

const SUBTAB_STAGE_MAP: Record<SubTabId, number> = {
  rig: 0,
  hnsw: 1,
  guardrail: 2,
  breaker: 3,
};

const NAV_SECTION_IDS = ["features", "architecture", "benchmarks", "sandbox", "integrations", "faq"] as const;

const ArrowIcon = () => (
  <svg className="m-arrow" viewBox="0 0 12 12" aria-hidden="true">
    <path className="m-arrow__stem" d="M1 6h8" />
    <path className="m-arrow__head" d="M4.5 2.5 8 6l-3.5 3.5" />
  </svg>
);

const StepCheckIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="m3.5 8.4 2.8 2.8 6.2-6.4" />
  </svg>
);

function formatRouteChip(routeUsed: string): string {
  if (routeUsed.includes("cache")) return "CACHE HIT";
  if (routeUsed.includes("fallback")) return "FALLBACK";
  if (routeUsed.includes("block")) return "BLOCK 403";
  return "PRIMARY";
}

export function App() {
  const [explodeAmount, setExplodeAmount] = useState(0);
  const [selectedBlade, setSelectedBlade] = useState(0);
  const [subTab, setSubTab] = useState<SubTabId>("rig");
  const [stageIdx, setStageIdx] = useState(0);
  const [postmortemIdx, setPostmortemIdx] = useState(0);
  const [policyRules, setPolicyRules] = useState([true, true, true]);
  const [activeSection, setActiveSection] = useState<string>("features");

  const [graph, setGraph] = useState<GraphSnapshot>(FALLBACK_GRAPH);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(FALLBACK_GRAPH.nodes[0]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkData>(VERIFIED_BENCHMARKS);
  const [evalReport, setEvalReport] = useState<EvalReport>(VERIFIED_EVALS);
  const [evalBusy, setEvalBusy] = useState(false);

  const [prompt, setPrompt] = useState(SANDBOX_PRESETS[0].prompt);
  const [bypassCache, setBypassCache] = useState(false);
  const [jsonMode, setJsonMode] = useState(false);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [sandboxStatus, setSandboxStatus] = useState("");
  const [primaryChaos, setPrimaryChaos] = useState("healthy");
  const [circuits, setCircuits] = useState<CircuitsSnapshot>({
    primary: {
      provider: "primary",
      state: "CLOSED",
      consecutive_failures: 0,
      window_failures: 0,
      window_size: 8,
      cooldown_remaining_sec: 0,
      total_trips: 0,
      last_reason: "healthy",
      chaos_mode: "healthy",
      model: "gpt-4o",
    },
    fallback: {
      provider: "fallback",
      state: "CLOSED",
      consecutive_failures: 0,
      window_failures: 0,
      window_size: 8,
      cooldown_remaining_sec: 0,
      total_trips: 0,
      last_reason: "healthy",
      chaos_mode: "healthy",
      model: "gpt-4o-mini",
    },
  });

  const [result, setResult] = useState<CompletionResult>(() =>
    runDemoSandboxFallback(SANDBOX_PRESETS[0].prompt, "healthy")
  );
  const [packetPulseKey, setPacketPulseKey] = useState(1);
  const [liveConnected, setLiveConnected] = useState(false);

  useEffect(() => {
    const sections = NAV_SECTION_IDS.map((id) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null
    );
    if (!sections.length) return;

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) {
          setActiveSection(visible.target.id);
        }
      },
      { rootMargin: "-25% 0px -45% 0px", threshold: [0.15, 0.5] }
    );

    sections.forEach((sec) => io.observe(sec));
    return () => io.disconnect();
  }, []);

  const primaryOpen = circuits.primary.state !== "CLOSED";
  const guardrailStatus: GuardrailAction = result.guardrail.action;
  const bucketFill = result.ratelimit
    ? Math.max(0.08, Math.min(1, result.ratelimit.remaining_tokens / Math.max(1, result.ratelimit.capacity)))
    : 0.92;

  const hnsw10k =
    benchmarks.scaling.find((r) => r.entries === 10000) ?? benchmarks.scaling[benchmarks.scaling.length - 1];
  const activeStage = BUILD_STAGES[stageIdx] ?? BUILD_STAGES[0];
  const activePostmortem = POSTMORTEMS[postmortemIdx] ?? POSTMORTEMS[0];
  const enabledRulesCount = policyRules.filter(Boolean).length;

  const evalCategories = Object.values(
    evalReport.cases.reduce<
      Record<string, { category: string; total: number; primary_passed: number; fallback_passed: number }>
    >((acc, c) => {
      const entry = acc[c.category] ?? {
        category: c.category.replace(/_/g, " "),
        total: 0,
        primary_passed: 0,
        fallback_passed: 0,
      };
      entry.total += 1;
      if (c.primary_pass) entry.primary_passed += 1;
      if (c.fallback_pass) entry.fallback_passed += 1;
      acc[c.category] = entry;
      return acc;
    }, {})
  );

  async function syncLiveGraph() {
    try {
      const [g, b] = await Promise.all([aegisApi.graph(), aegisApi.benchmarks()]);
      if (g.nodes.length > 0) {
        setGraph(g);
        setSelectedNode(g.nodes[0]);
      }
      setBenchmarks(b);
      setLiveConnected(true);
    } catch {
      // Offline preview retains bundled verified snapshots
    }
  }

  async function executePrompt(targetPrompt: string, targetBypass: boolean, targetJson: boolean) {
    if (!targetPrompt.trim()) return;
    setSandboxBusy(true);
    setSandboxStatus("Routing request through C++20 guardrail and HNSW index...");
    try {
      const resp = await aegisApi.complete({
        prompt: targetPrompt,
        tenant_id: "default",
        bypass_cache: targetBypass,
        json_mode: targetJson,
      });
      setResult(resp);
      setCircuits(resp.circuits);
      setLiveConnected(true);
      setSandboxStatus(`HTTP ${resp.status_code} via ${resp.route_used} in ${resp.total_ms.toFixed(2)} ms.`);
      void syncLiveGraph();
    } catch {
      const localResp = runDemoSandboxFallback(targetPrompt, primaryChaos);
      setResult(localResp);
      setSandboxStatus(`Simulated HTTP ${localResp.status_code} via ${localResp.route_used} in ${localResp.total_ms.toFixed(2)} ms.`);
    } finally {
      setPacketPulseKey((k) => k + 1);
      setSandboxBusy(false);
    }
  }

  function handleSandboxSubmit(e: FormEvent) {
    e.preventDefault();
    void executePrompt(prompt, bypassCache, jsonMode);
  }

  async function handleChaos(mode: string) {
    setPrimaryChaos(mode);
    try {
      const r = await aegisApi.setChaos("primary", mode);
      setCircuits(r.circuits);
      setLiveConnected(true);
      setSandboxStatus(`Primary relay mode updated to ${mode}.`);
    } catch {
      setCircuits((prev) => ({
        ...prev,
        primary: {
          ...prev.primary,
          chaos_mode: mode as never,
          state: mode === "healthy" ? "CLOSED" : "OPEN",
        },
      }));
      setSandboxStatus(`Primary relay simulation set to ${mode}.`);
    }
  }

  async function handleResetCircuits() {
    setPrimaryChaos("healthy");
    try {
      const r = await aegisApi.resetCircuits();
      setCircuits(r.circuits);
      setLiveConnected(true);
      setSandboxStatus("Primary and fallback circuit relays restored to CLOSED.");
    } catch {
      setCircuits((prev) => ({
        ...prev,
        primary: { ...prev.primary, chaos_mode: "healthy", state: "CLOSED", consecutive_failures: 0 },
      }));
      setSandboxStatus("Circuit relays reset to CLOSED.");
    }
  }

  async function handleRunEval() {
    setEvalBusy(true);
    try {
      const ev = await aegisApi.runEval();
      setEvalReport(ev);
      setLiveConnected(true);
    } catch {
      // Static build retains verified eval report
    } finally {
      setEvalBusy(false);
    }
  }

  const toggleRule = (idx: number) => {
    setPolicyRules((prev) => prev.map((v, i) => (i === idx ? !v : v)));
  };

  return (
    <>
      <header className="nav">
        <a className="skip-link" href="#main">
          Skip to gateway
        </a>
        <div className="wrap nav__bar">
          <a className="nav__logo" href="#top">
            <span className="mark" data-mark="stack" aria-hidden="true"></span>
            AegisKV
          </a>
          <nav className="nav__links" aria-label="Main">
            <div className="nav__item">
              <a
                className="nav__link"
                href="#architecture"
                aria-current={activeSection === "architecture" ? "page" : undefined}
              >
                Architecture
                <svg className="chev" viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M3 4.5l3 3 3-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </a>
              <div className="nav__menu">
                <div className="wrap grid">
                  <a className="menu-card span-4" href="#features">
                    <div className="panel menu-card__panel">
                      <span className="ui-logo">
                        <BrandIcon name="c-plusplus.svg" width={24} height={24} className="ic ic-svg ic-24" />
                      </span>
                    </div>
                    <span className="t-card">AegisKV gateway pipeline</span>
                    <span className="t-small muted">C++20 LRU sharding, Luhn redaction, WAL logs</span>
                  </a>
                  <a className="menu-card span-4" href="#architecture">
                    <div className="panel menu-card__panel">
                      <span className="ui-logo">
                        <BrandIcon name="fastapi.svg" width={24} height={24} className="ic ic-svg ic-24" />
                      </span>
                    </div>
                    <span className="t-card">AegisKV architecture inspector</span>
                    <span className="t-small muted">Interactive 4-step pipeline, safety, memory, backup</span>
                  </a>
                  <a className="menu-card span-4" href="#benchmarks">
                    <div className="panel menu-card__panel">
                      <span className="ui-logo">
                        <BrandIcon name="sqlite.svg" width={24} height={11} className="ic ic-svg ic-24" />
                      </span>
                    </div>
                    <span className="t-card">AegisKV single-core benchmarks</span>
                    <span className="t-small muted">6.09x search speedup and 15-case eval parity</span>
                  </a>
                </div>
              </div>
            </div>
            <div className="nav__item">
              <a
                className="nav__link"
                href="#features"
                aria-current={activeSection === "features" ? "page" : undefined}
              >
                Pipeline
              </a>
            </div>
            <div className="nav__item">
              <a
                className="nav__link"
                href="#benchmarks"
                aria-current={activeSection === "benchmarks" ? "page" : undefined}
              >
                Benchmarks
              </a>
            </div>
            <div className="nav__item">
              <a
                className="nav__link"
                href="#sandbox"
                aria-current={activeSection === "sandbox" ? "page" : undefined}
              >
                Sandbox
              </a>
            </div>
            <div className="nav__item">
              <a
                className="nav__link"
                href="#faq"
                aria-current={activeSection === "faq" ? "page" : undefined}
              >
                Questions
              </a>
            </div>
          </nav>
          <div className="nav__actions">
            <a className="btn btn--primary" href="#sandbox">
              Open sandbox
              <ArrowIcon />
            </a>
          </div>
          <button className="nav__toggle" type="button" aria-expanded="false" aria-label="Menu">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path d="M2 5h14M2 13h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <main id="main">
        <section className="hero hero--product" id="top" data-enter aria-labelledby="hero-h">
          <div className="wrap">
            <div className="hero-text hero__in">
              <div className="hero__head">
                <div>
                  <h1 id="hero-h">Semantic cache gateway for LLM APIs</h1>
                  <p className="hero__lead">
                    16-shard HNSW lookup in {hnsw10k.hnsw_p50_us.toFixed(1)} us at{" "}
                    {hnsw10k.recall_at_1_pct.toFixed(1)}% recall, with Luhn redaction and failover.
                  </p>
                </div>
                <div className="btn-row">
                  <a className="btn btn--primary" href="#sandbox">
                    Open sandbox
                    <ArrowIcon />
                  </a>
                  <a className="btn btn--secondary" href="#architecture">
                    See architecture
                  </a>
                </div>
              </div>
              <div className="hero__stage">
                <div data-product="aegis-rig" style={{ position: "absolute", inset: 0 }}>
                  <AegisCoreRig3D
                    explodeAmount={explodeAmount}
                    selectedBlade={selectedBlade}
                    onSelectBlade={(idx) => {
                      setSelectedBlade(idx);
                      setStageIdx(idx);
                    }}
                    primaryOpen={primaryOpen}
                    guardrailStatus={guardrailStatus}
                    activeRoute={result.route_used}
                    bucketFill={bucketFill}
                    packetPulseKey={packetPulseKey}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section g2 g2m bg-mist" id="features" aria-labelledby="features-h">
          <div className="wrap">
            <div className="group">
              <div className="section-head">
                <h2 id="features-h">
                  AegisKV gateway pipeline modules.{" "}
                  <span className="muted">C++20 critical-path indexing paired with FastAPI control relays.</span>
                </h2>
              </div>
              <div className="grid">
                <article className="card card--row card--open span-6">
                  <h3>AegisKV guardrail security</h3>
                  <p>
                    C++20 automata verify payment cards with Luhn mod-10 in{" "}
                    {benchmarks.guardrail.p50_us.toFixed(1)} us.
                  </p>
                  <div className="panel panel--flush">
                    <div className="stage">
                      <div className="at-corner fit">
                        <div className="ui ui-panel ui-toggles">
                          <div className="ui-head">
                            <svg className="ui-icon ui-toggles__ico" viewBox="0 0 16 16" aria-hidden="true">
                              <path d="M8 1.8 13 4v3.6c0 3-2.1 5.4-5 6.6-2.9-1.2-5-3.6-5-6.6V4z" />
                              <path d="m5.8 8 1.6 1.6 3-3.2" />
                            </svg>
                            <div className="ui-title">Perimeter policy</div>
                            <span className="ui-spacer" />
                            <div className="ui-meta">{enabledRulesCount}/3 on</div>
                          </div>
                          <ul className="ui-toggles__list">
                            {[
                              ["Prompt injection block", "Blocks HTTP 403 pre-lookup"],
                              ["Luhn mod-10 cards", "Ignores non-Luhn order IDs"],
                              ["Entropy key mask", "Masks keys > 3.95 entropy"],
                            ].map(([label, sub], idx) => (
                              <li className="ui-tg" key={label}>
                                <span className="ui-tg__text">
                                  <span className="ui-tg__label">{label}</span>
                                  <span className="ui-tg__sub">{sub}</span>
                                </span>
                                <button
                                  className={`ui-switch ${policyRules[idx] ? "is-on" : ""}`}
                                  type="button"
                                  role="switch"
                                  aria-checked={policyRules[idx]}
                                  aria-label={label}
                                  onClick={() => toggleRule(idx)}
                                >
                                  <i />
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>

                <article className="card card--row card--open span-6">
                  <h3>16-shard HNSW semantic cache</h3>
                  <p>
                    Lock-striped lookup cuts 10k-vector scan latency to{" "}
                    {hnsw10k.hnsw_p50_us.toFixed(1)} us.
                  </p>
                  <div className="panel panel--flush">
                    <div className="stage">
                      <div className="at-corner to-edge fit">
                        <div className="ui ui-panel ui-stat is-fill">
                          <div className="ui-stat__head">
                            <div className="ui-stat__top">
                              <span className="ui-stat__label">HNSW search (10k)</span>
                              <span className="ui-stat__range">256-dim</span>
                            </div>
                            <div className="ui-stat__line">
                              <span className="ui-stat__num">{hnsw10k.speedup.toFixed(2)}x</span>
                              <span className="ui-chip ui-chip--plain ui-stat__delta">
                                {hnsw10k.recall_at_1_pct.toFixed(1)}% Recall@1
                              </span>
                            </div>
                          </div>
                          <div className="ui-stat__chart">
                            <svg className="ui-stat__svg" viewBox="0 0 400 120" preserveAspectRatio="none" aria-hidden="true">
                              <path className="ui-stat__grid" d="M0 30.5H400M0 60.5H400M0 90.5H400" />
                              <g className="ui-stat__bars">
                                <rect rx="3" x="12" y="96" width="54" height="24" />
                                <rect rx="3" x="88" y="76" width="54" height="44" />
                                <rect rx="3" x="164" y="48" width="54" height="72" />
                                <rect rx="3" x="240" y="34" width="54" height="86" />
                                <rect rx="3" x="316" y="18" width="54" height="102" />
                              </g>
                            </svg>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              </div>
            </div>

            <div className="group">
              <div className="grid">
                <article className="card card--row card--open span-6">
                  <h3>Gateway three-state circuit relays</h3>
                  <p>
                    Sliding-window breakers isolate 429 or 503 bursts onto the standby model.
                  </p>
                  <div className="panel panel--flush">
                    <div className="stage">
                      <div className="at-corner to-edge fit">
                        <div className="ui ui-panel ui-pipe is-passed">
                          <div className="ui-pipe__head">
                            <span className="ui-pipe__repo">relay</span>
                            <i className="ui-pipe__slash">/</i>
                            <code className="ui-pipe__ref">{circuits.primary.state}</code>
                            <span className="ui-spacer" />
                            <span className="ui-chip ui-chip--ink ui-pipe__chip">
                              {formatRouteChip(result.route_used)}
                            </span>
                          </div>
                          <div className="ui-pipe__commit">
                            <span className="ui-pipe__msg">Request span trace</span>
                            <span className="ui-pipe__sha">{result.total_ms.toFixed(2)} ms</span>
                          </div>
                          <ol className="ui-pipe__steps">
                            {[
                              { name: "Guardrail", icon: "c-plusplus.svg", cmd: guardrailStatus, time: "76.6us" },
                              { name: "Normalize", icon: "python.svg", cmd: "256-dim", time: "18.2us" },
                              { name: "HNSW index", icon: "c-plusplus.svg", cmd: "16 shards", time: "96.9us" },
                              { name: "Breaker", icon: "fastapi.svg", cmd: circuits.primary.state, time: "4.1us" },
                              { name: "Fallback", icon: "openai.svg", cmd: circuits.fallback.model, time: circuits.fallback.state },
                            ].map((st) => (
                              <li className="ui-pipe__step is-done" key={st.name}>
                                <span className="ui-pipe__ico">
                                  <StepCheckIcon />
                                </span>
                                <span className="ui-pipe__name">
                                  <span className="ui-pipe__tool" aria-hidden="true">
                                    <BrandIcon name={st.icon} width={16} height={16} className="ic ic-svg ic-16" />
                                  </span>
                                  <span className="ui-pipe__nm">{st.name}</span>
                                </span>
                                <code className="ui-pipe__cmd">{st.cmd}</code>
                                <span className="ui-pipe__time">{st.time}</span>
                              </li>
                            ))}
                          </ol>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>

                <article className="card card--row card--open span-6">
                  <h3>SQLite WAL API telemetry suite</h3>
                  <p>
                    WAL spans record telemetry lock-free while 15 eval cases verify JSON parity.
                  </p>
                  <div className="panel panel--flush">
                    <div className="stage">
                      <div className="at-corner to-edge fit">
                        <div className="ui ui-panel ui-term">
                          <div className="ui-term__head">
                            <span className="ui-dots" aria-hidden="true">
                              <i />
                              <i />
                              <i />
                            </span>
                            <span className="ui-term__title">aegis-kv</span>
                            <span className="ui-meta">ctest</span>
                            <span className="ui-spacer" />
                            <span className="ui-chip ui-chip--plain">WAL</span>
                          </div>
                          <div className="ui-term__screen">
                            <div className="ui-term__track">
                              <div className="ui-term__ln ui-term__cmd is-ran">
                                <span className="ui-term__cwd">~/kv</span>
                                <span className="ui-term__sig">$</span>
                                <span className="ui-term__typed">ctest &amp;&amp; pytest</span>
                              </div>
                              {[
                                ["cpp_core/lru", "16 shards", "ok"],
                                ["cpp_core/hnsw", "99.6%", "ok"],
                                ["cpp_core/luhn", "76.6us", "ok"],
                                ["gateway/relay", "4 suites", "ok"],
                                ["eval/run_eval", `${evalReport.suite_size} cases`, "100%"],
                              ].map(([path, n, t]) => (
                                <div className="ui-term__ln ui-term__log" key={path}>
                                  <svg className="ui-term__tick" viewBox="0 0 16 16" aria-hidden="true">
                                    <path d="m3.5 8.4 2.8 2.8 6.2-6.4" />
                                  </svg>
                                  <span className="ui-term__path">{path}</span>
                                  <span className="ui-term__n">{n}</span>
                                  <span className="ui-term__t">{t}</span>
                                </div>
                              ))}
                              <div className="ui-term__ln ui-term__done">
                                <span className="ui-term__ok">
                                  <svg viewBox="0 0 16 16" aria-hidden="true">
                                    <path d="m4.5 8.3 2.4 2.4 4.6-5" />
                                  </svg>
                                </span>
                                <b>All passed</b>
                                <span className="ui-term__dim">
                                  {evalReport.cost_reduction_pct.toFixed(1)}% saved
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="architecture" aria-labelledby="arch-h">
          <div className="wrap grid grid--top">
            <div className="span-5">
              <div className="section-head">
                <h2 id="arch-h">How AegisKV works in 3D</h2>
                <p>Switch between the full 4-step pipeline and each individual gateway defense.</p>
              </div>

              <div className="tabs" role="tablist" aria-label="Subsystem inspector">
                {[
                  ["rig", "Pipeline"],
                  ["guardrail", "Safety"],
                  ["hnsw", "Memory"],
                  ["breaker", "Backup"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    className="tab"
                    aria-selected={subTab === id}
                    onClick={() => {
                      const nextTab = id as SubTabId;
                      setSubTab(nextTab);
                      setStageIdx(SUBTAB_STAGE_MAP[nextTab]);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="arch-body">
                <h3>{activeStage.title}</h3>
                <p>{activeStage.decisionSummary}</p>
                <p className="arch-tradeoff">{activeStage.tradeoffNote}</p>
              </div>

              <pre className="arch-code">
                <code>{activeStage.codeSnippet}</code>
              </pre>
            </div>

            <div className="span-6 start-7">
              <div className="arch-bar">
                <span>
                  {subTab === "rig" && BLADE_NAMES[selectedBlade]}
                  {subTab === "guardrail" && `Status: ${guardrailStatus} (blocks hacks, masks cards & keys)`}
                  {subTab === "hnsw" &&
                    (selectedNode
                      ? `Match node #${selectedNode.node_idx} on floor ${selectedNode.level}`
                      : "Yellow beam = fastest path to saved answer")}
                  {subTab === "breaker" &&
                    (primaryOpen
                      ? "Main AI down -> routed safely to Backup AI"
                      : "Main AI healthy -> requests flowing cleanly")}
                </span>
                {subTab === "rig" && (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => setExplodeAmount((v) => (v > 0 ? 0 : 1))}
                  >
                    {explodeAmount > 0 ? "Stack floors" : "Spread floors"}
                  </button>
                )}
              </div>
              <div className="arch-stage">
                <Suspense fallback={<div className="three-fallback" aria-label="Loading 3D view" />}>
                  {subTab === "hnsw" && (
                    <HnswCrystal3D
                      graph={graph}
                      hopTrace={result.cache.hop_trace ?? []}
                      selectedNodeIdx={selectedNode?.node_idx ?? null}
                      onSelectNode={setSelectedNode}
                      animateSearch={result.cache.hit}
                    />
                  )}
                  {subTab === "guardrail" && <GuardrailSieve3D mode={guardrailStatus} />}
                  {subTab === "breaker" && (
                    <BreakerManifold3D circuitState={circuits.primary.state} tokensRatio={bucketFill} />
                  )}
                  {subTab === "rig" && (
                    <AegisCoreRig3D
                      explodeAmount={explodeAmount}
                      selectedBlade={selectedBlade}
                      onSelectBlade={(idx) => {
                        setSelectedBlade(idx);
                        setStageIdx(idx);
                      }}
                      primaryOpen={primaryOpen}
                      guardrailStatus={guardrailStatus}
                      activeRoute={result.route_used}
                      bucketFill={bucketFill}
                      packetPulseKey={packetPulseKey}
                    />
                  )}
                </Suspense>
              </div>
            </div>
          </div>
        </section>

        <section
          className="section ground-inverse"
          id="benchmarks"
          data-moment="iris-opens"
          data-moment-opts='{"from":"base"}'
          aria-labelledby="bench-h"
        >
          <div className="wrap grid grid--top">
            <div className="span-5">
              <div className="section-head">
                <h2 id="bench-h">AegisKV single-core benchmarks</h2>
                <p>C++20 lookup scaling and 15-case parity.</p>
              </div>
              <div className="btn-row">
                <button type="button" className="btn btn--primary" onClick={handleRunEval} disabled={evalBusy}>
                  {evalBusy ? "Checking..." : "Check 15-case eval"}
                  <ArrowIcon />
                </button>
              </div>
              <ul className="rows" style={{ marginTop: "var(--s-5)" }}>
                <li>
                  <span className="rows__name">HNSW p50 (10k)</span>
                  <span className="rows__value">{hnsw10k.hnsw_p50_us.toFixed(2)} us</span>
                </li>
                <li>
                  <span className="rows__name">Brute-force (10k)</span>
                  <span className="rows__value">{hnsw10k.brute_p50_us.toFixed(2)} us</span>
                </li>
                <li>
                  <span className="rows__name">Guardrail scan</span>
                  <span className="rows__value">
                    {Math.round(benchmarks.guardrail.throughput_scans_per_sec).toLocaleString()}/s
                  </span>
                </li>
                <li>
                  <span className="rows__name">Cost reduction</span>
                  <span className="rows__value">{evalReport.cost_reduction_pct.toFixed(1)}%</span>
                </li>
              </ul>
            </div>

            <div className="span-6 start-7">
              <div className="card">
                <span className="result__fig">{hnsw10k.speedup.toFixed(2)}x</span>
                <p className="result__cap">
                  N=10,000 speedup ({hnsw10k.recall_at_1_pct.toFixed(1)}% Recall@1) ·{" "}
                  {evalReport.primary_pass_rate.toFixed(0)}%/{evalReport.fallback_pass_rate.toFixed(0)}% parity.
                </p>
                <ul className="result__bars" style={{ marginTop: "var(--s-4)" }}>
                  {benchmarks.scaling.map((row) => {
                    const widthPct = Math.min(100, Math.max(8, Math.round((row.hnsw_p50_us / row.brute_p50_us) * 100)));
                    return (
                      <li key={row.entries}>
                        <span>N={row.entries.toLocaleString()}</span>
                        <i style={{ ["--w" as string]: `${widthPct}%` }} />
                        <b>
                          {row.hnsw_p50_us.toFixed(1)} vs {row.brute_p50_us.toFixed(1)} us
                        </b>
                      </li>
                    );
                  })}
                </ul>
                <div className="eval-grid">
                  {evalCategories.map((cat) => (
                    <div className="eval-cell" key={cat.category}>
                      <span>{cat.category}</span>
                      <b>
                        {cat.primary_passed}/{cat.total} · {cat.fallback_passed}/{cat.total}
                      </b>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="sandbox" aria-labelledby="sandbox-h">
          <div className="wrap grid grid--top">
            <div className="span-5">
              <div className="section-head">
                <h2 id="sandbox-h">Live gateway sandbox</h2>
                <p>
                  {liveConnected
                    ? "Live FastAPI and C++20 engine active."
                    : "Submit any prompt to test HNSW caching, PII redaction, or failover."}
                </p>
              </div>

              <div className="tabs" role="group" aria-label="Prompt presets">
                {SANDBOX_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="tab"
                    aria-selected={prompt === preset.prompt}
                    onClick={() => {
                      setPrompt(preset.prompt);
                      setJsonMode(preset.jsonMode);
                      void executePrompt(preset.prompt, bypassCache, preset.jsonMode);
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <form className="form" onSubmit={handleSandboxSubmit} style={{ marginTop: "var(--s-4)" }}>
                <div className="field">
                  <label htmlFor="sb-prompt">Request prompt</label>
                  <textarea
                    id="sb-prompt"
                    rows={2}
                    autoComplete="off"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    required
                  />
                </div>
                <div className="sb-checks">
                  <label className="sb-check">
                    <input
                      type="checkbox"
                      checked={bypassCache}
                      onChange={(e) => setBypassCache(e.target.checked)}
                    />
                    Bypass cache
                  </label>
                  <label className="sb-check">
                    <input type="checkbox" checked={jsonMode} onChange={(e) => setJsonMode(e.target.checked)} />
                    Strict JSON mode
                  </label>
                </div>
                <div className="btn-row">
                  <button type="submit" className="btn btn--primary" disabled={sandboxBusy}>
                    {sandboxBusy ? "Routing..." : "Send prompt"}
                    <ArrowIcon />
                  </button>
                  <button type="button" className="btn btn--secondary" onClick={() => void handleResetCircuits()}>
                    Apply clean relays
                  </button>
                </div>
                <div className="form__status" role="status" aria-live="polite">
                  {sandboxStatus}
                </div>
              </form>

              <div className="tabs sb-chaos" role="group" aria-label="Chaos fault injection">
                {[
                  ["healthy", "Healthy"],
                  ["outage_503", "503 fault"],
                  ["rate_limit_429", "429 burst"],
                ].map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className="tab"
                    aria-selected={primaryChaos === mode}
                    onClick={() => void handleChaos(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="span-6 start-7">
              <div className="ui ui-panel sb-ui" aria-live="polite">
                <div className="ui-head">
                  <span className="ui-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <div className="ui-title">Gateway trace</div>
                  <span className="ui-spacer" />
                  <span className="ui-chip ui-chip--ink">
                    HTTP {result.status_code} · {result.total_ms.toFixed(2)} ms
                  </span>
                </div>

                <div className="sb-ui__answer">
                  <strong>Route: {result.route_used} · Guardrail: {guardrailStatus}</strong>
                  <p style={{ marginTop: "var(--s-2)" }}>{result.answer}</p>
                </div>

                <ul className="rows sb-ui__spans">
                  {result.spans.slice(0, 4).map((sp) => (
                    <li key={sp.name}>
                      <span className="rows__name">
                        {sp.name}{" "}
                        <small>{sp.status}</small>
                      </span>
                      <span className="rows__value">
                        {sp.duration_ms < 1 ? `${sp.duration_us.toFixed(1)} us` : `${sp.duration_ms.toFixed(1)} ms`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="section ground-surface" id="integrations" aria-labelledby="stack-h">
          <div className="wrap grid grid--top">
            <div className="span-5">
              <div className="section-head">
                <h2 id="stack-h">AegisKV stack and defect cases</h2>
                <p>Four gateway bugs resolved by deterministic C++20 and Python tests.</p>
              </div>
              <div className="tabs" role="tablist" aria-label="Engineering defect cases">
                {POSTMORTEMS.map((pm, idx) => (
                  <button
                    key={pm.id}
                    type="button"
                    role="tab"
                    className="tab"
                    aria-selected={postmortemIdx === idx}
                    onClick={() => setPostmortemIdx(idx)}
                  >
                    Case {idx + 1}
                  </button>
                ))}
              </div>
              <div className="postmortem-detail">
                <div className="postmortem-detail__item">
                  <h3>{activePostmortem.title}</h3>
                  <p>{activePostmortem.symptom}</p>
                </div>
                <div className="postmortem-detail__item">
                  <h3>Gateway fix and regression test</h3>
                  <p>{activePostmortem.fix}</p>
                </div>
              </div>
            </div>

            <div className="span-6 start-7">
              <div className="stack-diagram-panel">
                <div className="dg" data-icon-base="assets/icons" data-dg-still="" data-diagram={HUB_DIAGRAM_SPEC} />
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="faq" aria-labelledby="faq-h">
          <div className="wrap grid grid--top">
            <div className="span-6">
              <div className="section-head">
                <h2 id="faq-h">AegisKV architecture questions</h2>
                <p>C++20 locking, compaction, guardrails, and failover parity.</p>
              </div>
              <div className="faq">
                <div className="faq__item">
                  <h3>Why 16 HNSW shards in C++20?</h3>
                  <p>Lock-striped ctypes calls release the GIL and finish cosine lookup in 96.9 us.</p>
                </div>
                <div className="faq__item">
                  <h3>How does HNSW cache eviction hold?</h3>
                  <p>Evicted vertices tombstone during traversal until 35% dead entries trigger compaction.</p>
                </div>
                <div className="faq__item">
                  <h3>How does the Luhn guardrail avoid false blocks?</h3>
                  <p>Luhn mod-10 verifies card checksums while Shannon entropy flags secrets in 76.6 us.</p>
                </div>
                <div className="faq__item">
                  <h3>What keeps gateway failover schema-safe?</h3>
                  <p>A 15-case golden suite verifies 100% JSON and policy parity on gpt-4o-mini.</p>
                </div>
              </div>
            </div>

            <div className="span-6 start-7">
              <div className="panel faq-panel">
                <div className="ui ui-panel faq-ui">
                  <div className="ui-head">
                    <span className="ui-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    <div className="ui-title">Gateway invariants</div>
                    <span className="ui-spacer" />
                    <span className="ui-chip ui-chip--ink">Verified</span>
                  </div>
                  <div className="faq-ui__stack">
                    {[
                      { label: "C++20 core", metric: "16 shards · 96.9 us", icon: "c-plusplus.svg" },
                      { label: "Luhn guardrail", metric: "0% false block · 76.6 us", icon: "c-plusplus.svg" },
                      { label: "Python C-ABI", metric: "GIL-free ctypes", icon: "python.svg" },
                      { label: "FastAPI relay", metric: "3-state breaker", icon: "fastapi.svg" },
                      { label: "SQLite WAL", metric: "15/15 eval parity", icon: "sqlite.svg" },
                    ].map((item) => (
                      <div className="faq-ui__row" key={item.label}>
                        <span className="faq-ui__ico" aria-hidden="true">
                          <BrandIcon name={item.icon} width={20} height={20} className="ic ic-svg ic-20" />
                        </span>
                        <span className="faq-ui__lbl">{item.label}</span>
                        <span className="faq-ui__val">{item.metric}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer closing footer--dark ground-surface" id="contact" aria-labelledby="close-h">
        <div className="wrap">
          <div className="closing__cta close--word">
            <div className="section-head--split">
              <div>
                <h2 id="close-h">Test AegisKV against your prompts</h2>
                <p className="t-lead">Self-hosted C++20 core, FastAPI control plane, and live trace console.</p>
              </div>
              <a className="btn btn--primary" href="#sandbox">
                Open sandbox
                <ArrowIcon />
              </a>
            </div>
            <p className="close__word" aria-hidden="true">
              AegisKV
            </p>
          </div>

          <div className="closing__links">
            <div className="grid">
              <div className="span-6 stack-4">
                <a className="nav__logo" href="#top">
                  <span className="mark" data-mark="stack" aria-hidden="true"></span>
                  AegisKV
                </a>
                <p className="footer__lede">
                  Semantic vector cache, perimeter guardrail, and failover relay built in C++20 and Python.
                </p>
              </div>
              <div className="span-3 footer__col">
                <h3>Pipeline</h3>
                <ul>
                  <li>
                    <a href="#features">Guardrail sieve</a>
                  </li>
                  <li>
                    <a href="#architecture">3D inspector</a>
                  </li>
                </ul>
              </div>
              <div className="span-3 footer__col">
                <h3>Gateway</h3>
                <ul>
                  <li>
                    <a href="#benchmarks">Benchmarks</a>
                  </li>
                  <li>
                    <a href="#integrations">Defect cases</a>
                  </li>
                </ul>
              </div>
            </div>

            <div className="footer__legal">
              <span>&copy; 2026 Arjun Kotwal &middot; AegisKV</span>
              <span className="footer__legal-links">
                <a href="privacy.html">Privacy</a>
                <a href="terms.html">Terms</a>
              </span>
              <span className="credits">
                C++, Python, FastAPI, SQLite, React, TypeScript, and OpenAI marks belong to their respective owners and
                indicate stack integration.
              </span>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}

export default App;
