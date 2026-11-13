#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <list>
#include <mutex>
#include <random>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace aegis {

struct CacheConfig {
    uint32_t vector_dim = 256;
    uint32_t max_entries = 10000;
    uint32_t hnsw_m = 16;
    uint32_t ef_construction = 64;
    uint32_t ef_search = 32;
    uint32_t default_ttl_sec = 3600;
};

struct SearchCandidate {
    uint32_t entry_id = 0;
    uint32_t node_idx = 0;
    float similarity = 0.0f;
    std::string key_preview;
    std::string payload_json;
};

struct SearchHop {
    uint32_t node_idx = 0;
    int level = 0;
    float similarity = 0.0f;
};

struct CacheSearchResult {
    bool hit = false;
    float similarity = 0.0f;
    int32_t entry_id = -1;
    std::string payload_json;
    uint32_t hops_evaluated = 0;
    double search_us = 0.0;
    std::vector<SearchCandidate> candidates;
    std::vector<SearchHop> hop_trace;
};

class HnswSemanticCache {
public:
    static constexpr uint32_t kNumShards = 16;

    explicit HnswSemanticCache(const CacheConfig& cfg);

    int32_t upsert(
        const std::string& key,
        const float* vec,
        uint32_t dim,
        const std::string& payload_json,
        uint32_t ttl_sec
    );

    CacheSearchResult search(
        const float* vec,
        uint32_t dim,
        float threshold,
        uint32_t top_k
    );

    void clear();

    std::string graph_snapshot_json(uint32_t max_nodes) const;
    std::string stats_json() const;

    uint64_t hits() const { return hits_.load(std::memory_order_relaxed); }
    uint64_t misses() const { return misses_.load(std::memory_order_relaxed); }
    uint64_t evictions() const { return evictions_.load(std::memory_order_relaxed); }

    // Exposed for benchmarking HNSW vs brute-force cosine scan
    float brute_force_best_similarity(const float* vec, uint32_t dim) const;

    static std::string search_result_to_json(const CacheSearchResult& res);

private:
    struct CacheEntry {
        uint32_t entry_id = 0;
        uint32_t node_idx = 0;
        std::string key;
        std::string payload_json;
        std::chrono::steady_clock::time_point expires_at;
        uint64_t hit_count = 0;
    };

    struct CacheShard {
        mutable std::mutex mu;
        std::list<uint32_t> lru_list;  // front = MRU, back = LRU
        std::unordered_map<uint32_t, std::list<uint32_t>::iterator> lru_pos;
        std::unordered_map<uint32_t, CacheEntry> entries;
        std::unordered_map<std::string, uint32_t> key_to_id;
    };

    struct HnswNode {
        uint32_t entry_id = 0;
        int level = 0;
        bool tombstoned = false;
        std::string key_preview;
        std::vector<float> vec;
        std::array<float, 3> proj_3d{0.0f, 0.0f, 0.0f};
        std::vector<std::vector<uint32_t>> neighbors;
    };

    CacheConfig cfg_;
    std::array<CacheShard, kNumShards> shards_;

    mutable std::shared_mutex graph_mu_;
    std::vector<HnswNode> nodes_;
    int32_t entry_point_ = -1;
    int max_level_ = -1;
    uint32_t tombstone_count_ = 0;

    std::atomic<uint32_t> next_seq_{1};
    std::atomic<uint64_t> active_entries_{0};
    std::atomic<uint64_t> hits_{0};
    std::atomic<uint64_t> misses_{0};
    std::atomic<uint64_t> evictions_{0};
    std::atomic<uint64_t> expirations_{0};
    std::atomic<uint64_t> total_search_ns_{0};
    std::atomic<uint64_t> total_searches_{0};

    std::mutex rng_mu_;
    std::mt19937 rng_{0xAE61542ULL};

    int sample_level();
    static uint32_t shard_for_key(const std::string& key);
    static uint32_t shard_for_id(uint32_t entry_id) { return entry_id & (kNumShards - 1); }
    static std::vector<float> normalize_vector(const float* vec, uint32_t dim);
    static std::array<float, 3> compute_3d_projection(const std::vector<float>& vec);
    static float dot_product(const float* a, const float* b, uint32_t dim);

    void evict_one_lru_locked_graph();
    void insert_node_locked(uint32_t node_idx);
    uint32_t greedy_descent_locked(const float* q, uint32_t curr, int level, uint32_t& hops, std::vector<SearchHop>* trace) const;
    std::vector<std::pair<float, uint32_t>> search_layer_locked(
        const float* q,
        uint32_t enter_idx,
        int level,
        uint32_t ef,
        uint32_t& hops,
        std::vector<SearchHop>* trace
    ) const;
    void select_neighbors_heuristic_locked(
        const float* q,
        const std::vector<std::pair<float, uint32_t>>& candidates,
        uint32_t max_m,
        std::vector<uint32_t>& out_neighbors
    ) const;
    void compact_locked();
};

}  // namespace aegis
