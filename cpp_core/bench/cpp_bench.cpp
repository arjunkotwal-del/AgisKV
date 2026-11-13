#include "guardrail.hpp"
#include "hnsw_cache.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <random>
#include <string>
#include <vector>

namespace {

double percentile(std::vector<double>& vals, double pct) {
    if (vals.empty()) return 0.0;
    std::sort(vals.begin(), vals.end());
    size_t idx = static_cast<size_t>(pct * static_cast<double>(vals.size() - 1));
    return vals[idx];
}

std::vector<float> random_unit_vec(uint32_t dim, std::mt19937& rng) {
    std::normal_distribution<float> dist(0.0f, 1.0f);
    std::vector<float> v(dim);
    double norm_sq = 0.0;
    for (float& x : v) {
        x = dist(rng);
        norm_sq += static_cast<double>(x) * x;
    }
    float inv = static_cast<float>(1.0 / std::sqrt(norm_sq));
    for (float& x : v) x *= inv;
    return v;
}

}  // namespace

int main(int argc, char** argv) {
    std::string out_path = (argc > 1) ? argv[1] : "bench_results.json";
    const uint32_t dim = 256;
    const std::vector<uint32_t> sizes = {500, 2000, 5000, 10000};
    const uint32_t num_queries = 250;

    std::mt19937 rng(20261113);
    std::normal_distribution<float> noise_dist(0.0f, 0.025f);

    std::ofstream json_out(out_path);
    json_out << std::fixed << std::setprecision(2);
    json_out << "{\n  \"vector_dim\": " << dim << ",\n  \"num_queries\": " << num_queries
             << ",\n  \"scaling\": [\n";

    std::cout << "=== AegisKV C++20 Benchmark (dim=" << dim << ") ===\n";

    for (size_t s_idx = 0; s_idx < sizes.size(); ++s_idx) {
        const uint32_t n = sizes[s_idx];
        aegis::CacheConfig cfg;
        cfg.vector_dim = dim;
        cfg.max_entries = n + 100;
        cfg.hnsw_m = 16;
        cfg.ef_construction = 64;
        cfg.ef_search = 32;

        aegis::HnswSemanticCache cache(cfg);
        std::vector<std::vector<float>> base_vecs;
        base_vecs.reserve(n);

        const auto insert_t0 = std::chrono::steady_clock::now();
        for (uint32_t i = 0; i < n; ++i) {
            auto v = random_unit_vec(dim, rng);
            base_vecs.push_back(v);
            cache.upsert("doc-" + std::to_string(i), v.data(), dim, "{\"id\":" + std::to_string(i) + "}", 3600);
        }
        const auto insert_t1 = std::chrono::steady_clock::now();
        const double insert_ms = std::chrono::duration<double, std::milli>(insert_t1 - insert_t0).count();

        std::vector<double> hnsw_us;
        std::vector<double> brute_us;
        hnsw_us.reserve(num_queries);
        brute_us.reserve(num_queries);
        uint32_t recall_hits = 0;

        for (uint32_t q_i = 0; q_i < num_queries; ++q_i) {
            const uint32_t target = (q_i * 37) % n;
            auto q = base_vecs[target];
            for (float& x : q) x += noise_dist(rng);

            const auto h0 = std::chrono::steady_clock::now();
            auto res = cache.search(q.data(), dim, 0.85f, 3);
            const auto h1 = std::chrono::steady_clock::now();
            hnsw_us.push_back(std::chrono::duration<double, std::micro>(h1 - h0).count());

            const auto b0 = std::chrono::steady_clock::now();
            float exact_best = cache.brute_force_best_similarity(q.data(), dim);
            const auto b1 = std::chrono::steady_clock::now();
            brute_us.push_back(std::chrono::duration<double, std::micro>(b1 - b0).count());

            if (res.hit && std::abs(res.similarity - exact_best) < 0.015f) {
                recall_hits++;
            }
        }

        const double hnsw_p50 = percentile(hnsw_us, 0.50);
        const double hnsw_p95 = percentile(hnsw_us, 0.95);
        const double hnsw_p99 = percentile(hnsw_us, 0.99);
        const double brute_p50 = percentile(brute_us, 0.50);
        const double brute_p95 = percentile(brute_us, 0.95);
        const double speedup = (hnsw_p50 > 0.0) ? (brute_p50 / hnsw_p50) : 1.0;
        const double recall_pct = 100.0 * static_cast<double>(recall_hits) / num_queries;

        std::cout << "N=" << std::setw(5) << n
                  << " | Insert: " << std::setw(7) << insert_ms << " ms"
                  << " | HNSW p50/p95: " << std::setw(6) << hnsw_p50 << " / " << std::setw(6) << hnsw_p95 << " us"
                  << " | Brute p50: " << std::setw(7) << brute_p50 << " us"
                  << " | Speedup: " << std::setw(5) << speedup << "x"
                  << " | Recall@1: " << recall_pct << "%\n";

        json_out << "    {"
                 << "\"entries\": " << n << ", "
                 << "\"insert_total_ms\": " << insert_ms << ", "
                 << "\"hnsw_p50_us\": " << hnsw_p50 << ", "
                 << "\"hnsw_p95_us\": " << hnsw_p95 << ", "
                 << "\"hnsw_p99_us\": " << hnsw_p99 << ", "
                 << "\"brute_p50_us\": " << brute_p50 << ", "
                 << "\"brute_p95_us\": " << brute_p95 << ", "
                 << "\"speedup\": " << speedup << ", "
                 << "\"recall_at_1_pct\": " << recall_pct
                 << "}" << (s_idx + 1 < sizes.size() ? "," : "") << "\n";
    }

    // Guardrail throughput benchmark
    aegis::GuardrailScanner scanner;
    const std::string sample_payload =
        "Summarize PostgreSQL MVCC vacuum tuning for high-write SaaS tables. "
        "Contact engineering-ops@example.com for staging metrics, token sk-proj-TestKey99887766554433221100.";
    const uint32_t gr_iters = 5000;
    std::vector<double> gr_us;
    gr_us.reserve(gr_iters);
    const auto g_start = std::chrono::steady_clock::now();
    for (uint32_t i = 0; i < gr_iters; ++i) {
        const auto t0 = std::chrono::steady_clock::now();
        auto r = scanner.scan(sample_payload);
        const auto t1 = std::chrono::steady_clock::now();
        (void)r;
        gr_us.push_back(std::chrono::duration<double, std::micro>(t1 - t0).count());
    }
    const auto g_end = std::chrono::steady_clock::now();
    const double total_sec = std::chrono::duration<double>(g_end - g_start).count();
    const double gr_qps = static_cast<double>(gr_iters) / total_sec;
    const double gr_p50 = percentile(gr_us, 0.50);
    const double gr_p95 = percentile(gr_us, 0.95);

    std::cout << "Guardrail Scanner (" << gr_iters << " scans): p50=" << gr_p50
              << " us, p95=" << gr_p95 << " us, throughput=" << gr_qps << " scans/sec\n";

    json_out << "  ],\n"
             << "  \"guardrail\": {\n"
             << "    \"iterations\": " << gr_iters << ",\n"
             << "    \"p50_us\": " << gr_p50 << ",\n"
             << "    \"p95_us\": " << gr_p95 << ",\n"
             << "    \"throughput_scans_per_sec\": " << gr_qps << "\n"
             << "  }\n}\n";
    return 0;
}
