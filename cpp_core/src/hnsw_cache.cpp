#include "hnsw_cache.hpp"
#include "json_util.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <queue>
#include <sstream>
#include <unordered_set>

namespace aegis {

HnswSemanticCache::HnswSemanticCache(const CacheConfig& cfg) : cfg_(cfg) {
    if (cfg_.vector_dim == 0) cfg_.vector_dim = 256;
    if (cfg_.max_entries == 0) cfg_.max_entries = 10000;
    if (cfg_.hnsw_m < 4) cfg_.hnsw_m = 4;
    if (cfg_.ef_construction < cfg_.hnsw_m) cfg_.ef_construction = cfg_.hnsw_m * 2;
    if (cfg_.ef_search < 8) cfg_.ef_search = 16;
    if (cfg_.default_ttl_sec == 0) cfg_.default_ttl_sec = 3600;
}

uint32_t HnswSemanticCache::shard_for_key(const std::string& key) {
    // FNV-1a 32-bit hash for deterministic shard partitioning
    uint32_t h = 2166136261u;
    for (unsigned char c : key) {
        h ^= c;
        h *= 16777619u;
    }
    return h & (kNumShards - 1);
}

int HnswSemanticCache::sample_level() {
    std::lock_guard<std::mutex> lock(rng_mu_);
    std::uniform_real_distribution<double> dist(1e-9, 1.0);
    const double mult = 1.0 / std::log(static_cast<double>(cfg_.hnsw_m));
    int lvl = static_cast<int>(-std::log(dist(rng_)) * mult);
    return std::min(lvl, 8);
}

std::vector<float> HnswSemanticCache::normalize_vector(const float* vec, uint32_t dim) {
    std::vector<float> out(dim, 0.0f);
    if (!vec || dim == 0) return out;
    double norm_sq = 0.0;
    for (uint32_t i = 0; i < dim; ++i) {
        const float v = vec[i];
        out[i] = v;
        norm_sq += static_cast<double>(v) * static_cast<double>(v);
    }
    const double norm = std::sqrt(norm_sq);
    if (norm > 1e-12) {
        const float inv = static_cast<float>(1.0 / norm);
        for (uint32_t i = 0; i < dim; ++i) {
            out[i] *= inv;
        }
    }
    return out;
}

std::array<float, 3> HnswSemanticCache::compute_3d_projection(const std::vector<float>& vec) {
    // Deterministic 3-axis Hadamard-like projection so semantically close vectors cluster in 3D space
    std::array<float, 3> p{0.0f, 0.0f, 0.0f};
    const size_t n = vec.size();
    for (size_t i = 0; i < n; ++i) {
        const float v = vec[i];
        const int s0 = ((i * 2654435761u) & 1u) ? 1 : -1;
        const int s1 = (((i + 17) * 2246822519u) & 1u) ? 1 : -1;
        const int s2 = (((i + 53) * 3266489917u) & 1u) ? 1 : -1;
        p[0] += v * static_cast<float>(s0);
        p[1] += v * static_cast<float>(s1);
        p[2] += v * static_cast<float>(s2);
    }
    const float scale = (n > 0) ? (3.5f / std::sqrt(static_cast<float>(n))) : 1.0f;
    return {p[0] * scale, p[1] * scale, p[2] * scale};
}

float HnswSemanticCache::dot_product(const float* a, const float* b, uint32_t dim) {
    float s0 = 0.0f, s1 = 0.0f, s2 = 0.0f, s3 = 0.0f;
    uint32_t i = 0;
    for (; i + 4 <= dim; i += 4) {
        s0 += a[i] * b[i];
        s1 += a[i + 1] * b[i + 1];
        s2 += a[i + 2] * b[i + 2];
        s3 += a[i + 3] * b[i + 3];
    }
    float total = (s0 + s1) + (s2 + s3);
    for (; i < dim; ++i) {
        total += a[i] * b[i];
    }
    return std::clamp(total, -1.0f, 1.0f);
}

void HnswSemanticCache::evict_one_lru_locked_graph() {
    // Choose the shard with the largest occupancy and evict its LRU tail
    size_t best_shard = 0;
    size_t best_count = 0;
    for (uint32_t s = 0; s < kNumShards; ++s) {
        std::lock_guard<std::mutex> slock(shards_[s].mu);
        if (shards_[s].entries.size() > best_count) {
            best_count = shards_[s].entries.size();
            best_shard = s;
        }
    }
    if (best_count == 0) return;

    uint32_t evicted_node_idx = std::numeric_limits<uint32_t>::max();
    {
        CacheShard& shard = shards_[best_shard];
        std::lock_guard<std::mutex> slock(shard.mu);
        if (shard.lru_list.empty()) return;
        const uint32_t victim_id = shard.lru_list.back();
        shard.lru_list.pop_back();
        shard.lru_pos.erase(victim_id);
        auto it = shard.entries.find(victim_id);
        if (it != shard.entries.end()) {
            evicted_node_idx = it->second.node_idx;
            shard.key_to_id.erase(it->second.key);
            shard.entries.erase(it);
            active_entries_.fetch_sub(1, std::memory_order_relaxed);
            evictions_.fetch_add(1, std::memory_order_relaxed);
        }
    }

    if (evicted_node_idx < nodes_.size() && !nodes_[evicted_node_idx].tombstoned) {
        nodes_[evicted_node_idx].tombstoned = true;
        tombstone_count_++;
    }
}

uint32_t HnswSemanticCache::greedy_descent_locked(
    const float* q,
    uint32_t curr,
    int level,
    uint32_t& hops,
    std::vector<SearchHop>* trace
) const {
    float curr_sim = dot_product(q, nodes_[curr].vec.data(), cfg_.vector_dim);
    if (trace) trace->push_back(SearchHop{curr, level, curr_sim});

    bool improved = true;
    while (improved) {
        improved = false;
        if (level < static_cast<int>(nodes_[curr].neighbors.size())) {
            for (uint32_t nb : nodes_[curr].neighbors[level]) {
                hops++;
                const float nb_sim = dot_product(q, nodes_[nb].vec.data(), cfg_.vector_dim);
                if (nb_sim > curr_sim) {
                    curr_sim = nb_sim;
                    curr = nb;
                    improved = true;
                    if (trace) trace->push_back(SearchHop{curr, level, curr_sim});
                }
            }
        }
    }
    return curr;
}

std::vector<std::pair<float, uint32_t>> HnswSemanticCache::search_layer_locked(
    const float* q,
    uint32_t enter_idx,
    int level,
    uint32_t ef,
    uint32_t& hops,
    std::vector<SearchHop>* trace
) const {
    using Pair = std::pair<float, uint32_t>;
    // max-heap for candidates to explore next (highest similarity first)
    std::priority_queue<Pair> candidates;
    // min-heap for current best ef results (lowest similarity on top for quick pruning)
    std::priority_queue<Pair, std::vector<Pair>, std::greater<Pair>> best;

    std::vector<uint8_t> visited(nodes_.size(), 0);
    visited[enter_idx] = 1;

    const float enter_sim = dot_product(q, nodes_[enter_idx].vec.data(), cfg_.vector_dim);
    candidates.emplace(enter_sim, enter_idx);
    best.emplace(enter_sim, enter_idx);
    if (trace) trace->push_back(SearchHop{enter_idx, level, enter_sim});

    while (!candidates.empty()) {
        auto [c_sim, c_idx] = candidates.top();
        candidates.pop();

        const float worst_best_sim = best.top().first;
        if (best.size() >= ef && c_sim < worst_best_sim) {
            break;
        }

        if (level < static_cast<int>(nodes_[c_idx].neighbors.size())) {
            for (uint32_t nb : nodes_[c_idx].neighbors[level]) {
                if (nb >= nodes_.size() || visited[nb]) continue;
                visited[nb] = 1;
                hops++;

                const float nb_sim = dot_product(q, nodes_[nb].vec.data(), cfg_.vector_dim);
                if (best.size() < ef || nb_sim > best.top().first) {
                    candidates.emplace(nb_sim, nb);
                    best.emplace(nb_sim, nb);
                    if (trace && trace->size() < 48) {
                        trace->push_back(SearchHop{nb, level, nb_sim});
                    }
                    if (best.size() > ef) {
                        best.pop();
                    }
                }
            }
        }
    }

    std::vector<Pair> result;
    result.reserve(best.size());
    while (!best.empty()) {
        result.push_back(best.top());
        best.pop();
    }
    std::sort(result.begin(), result.end(), [](const Pair& a, const Pair& b) {
        return a.first > b.first;
    });
    return result;
}

void HnswSemanticCache::select_neighbors_heuristic_locked(
    const float* /*q*/,
    const std::vector<std::pair<float, uint32_t>>& candidates,
    uint32_t max_m,
    std::vector<uint32_t>& out_neighbors
) const {
    out_neighbors.clear();
    for (const auto& [sim, idx] : candidates) {
        if (out_neighbors.size() >= max_m) break;
        if (!nodes_[idx].tombstoned) {
            out_neighbors.push_back(idx);
        }
    }
    // Fallback if all candidates were tombstoned so graph bridges remain connected
    if (out_neighbors.empty()) {
        for (const auto& [sim, idx] : candidates) {
            if (out_neighbors.size() >= max_m) break;
            out_neighbors.push_back(idx);
        }
    }
}

void HnswSemanticCache::insert_node_locked(uint32_t node_idx) {
    HnswNode& node = nodes_[node_idx];
    const int lvl = node.level;
    node.neighbors.resize(static_cast<size_t>(lvl + 1));

    if (entry_point_ < 0) {
        entry_point_ = static_cast<int32_t>(node_idx);
        max_level_ = lvl;
        return;
    }

    uint32_t curr = static_cast<uint32_t>(entry_point_);
    uint32_t dummy_hops = 0;

    for (int l = max_level_; l > lvl; --l) {
        curr = greedy_descent_locked(node.vec.data(), curr, l, dummy_hops, nullptr);
    }

    const int top_connect = std::min(lvl, max_level_);
    for (int l = top_connect; l >= 0; --l) {
        auto candidates = search_layer_locked(
            node.vec.data(), curr, l, cfg_.ef_construction, dummy_hops, nullptr
        );
        const uint32_t max_m = (l == 0) ? (cfg_.hnsw_m * 2) : cfg_.hnsw_m;
        select_neighbors_heuristic_locked(node.vec.data(), candidates, max_m, node.neighbors[l]);

        // Bidirectional links with bounded degree pruning
        for (uint32_t nb : node.neighbors[l]) {
            if (nb == node_idx) continue;
            if (l >= static_cast<int>(nodes_[nb].neighbors.size())) continue;
            auto& nb_list = nodes_[nb].neighbors[l];
            if (std::find(nb_list.begin(), nb_list.end(), node_idx) == nb_list.end()) {
                nb_list.push_back(node_idx);
                if (nb_list.size() > max_m) {
                    // Keep closest max_m neighbors
                    std::vector<std::pair<float, uint32_t>> scored;
                    scored.reserve(nb_list.size());
                    for (uint32_t other : nb_list) {
                        const float s = dot_product(
                            nodes_[nb].vec.data(), nodes_[other].vec.data(), cfg_.vector_dim
                        );
                        scored.emplace_back(s, other);
                    }
                    std::sort(scored.begin(), scored.end(), [](const auto& a, const auto& b) {
                        return a.first > b.first;
                    });
                    nb_list.clear();
                    for (size_t k = 0; k < max_m && k < scored.size(); ++k) {
                        nb_list.push_back(scored[k].second);
                    }
                }
            }
        }
        if (!candidates.empty()) {
            curr = candidates.front().second;
        }
    }

    if (lvl > max_level_) {
        entry_point_ = static_cast<int32_t>(node_idx);
        max_level_ = lvl;
    }
}

void HnswSemanticCache::compact_locked() {
    std::vector<HnswNode> old_nodes = std::move(nodes_);
    nodes_.clear();
    entry_point_ = -1;
    max_level_ = -1;
    tombstone_count_ = 0;

    for (auto& old : old_nodes) {
        if (old.tombstoned) continue;
        const uint32_t new_idx = static_cast<uint32_t>(nodes_.size());
        old.neighbors.clear();
        nodes_.push_back(std::move(old));
        insert_node_locked(new_idx);

        const uint32_t s = shard_for_id(nodes_[new_idx].entry_id);
        std::lock_guard<std::mutex> slock(shards_[s].mu);
        auto it = shards_[s].entries.find(nodes_[new_idx].entry_id);
        if (it != shards_[s].entries.end()) {
            it->second.node_idx = new_idx;
        }
    }
}

int32_t HnswSemanticCache::upsert(
    const std::string& key,
    const float* vec,
    uint32_t dim,
    const std::string& payload_json,
    uint32_t ttl_sec
) {
    if (!vec || dim != cfg_.vector_dim) return -1;

    auto norm_vec = normalize_vector(vec, dim);
    auto proj_3d = compute_3d_projection(norm_vec);
    const uint32_t effective_ttl = (ttl_sec > 0) ? ttl_sec : cfg_.default_ttl_sec;
    const auto expires_at = std::chrono::steady_clock::now() + std::chrono::seconds(effective_ttl);
    const uint32_t shard_idx = shard_for_key(key);

    std::unique_lock<std::shared_mutex> glock(graph_mu_);

    // Evict if at capacity and this is a new key
    bool key_exists = false;
    {
        std::lock_guard<std::mutex> slock(shards_[shard_idx].mu);
        key_exists = (shards_[shard_idx].key_to_id.find(key) != shards_[shard_idx].key_to_id.end());
    }
    if (!key_exists && active_entries_.load(std::memory_order_relaxed) >= cfg_.max_entries) {
        evict_one_lru_locked_graph();
    }

    uint32_t entry_id = 0;
    const uint32_t new_node_idx = static_cast<uint32_t>(nodes_.size());

    {
        CacheShard& shard = shards_[shard_idx];
        std::lock_guard<std::mutex> slock(shard.mu);
        auto kit = shard.key_to_id.find(key);
        if (kit != shard.key_to_id.end()) {
            entry_id = kit->second;
            auto eit = shard.entries.find(entry_id);
            if (eit != shard.entries.end()) {
                const uint32_t old_node_idx = eit->second.node_idx;
                if (old_node_idx < nodes_.size() && !nodes_[old_node_idx].tombstoned) {
                    nodes_[old_node_idx].tombstoned = true;
                    tombstone_count_++;
                }
                eit->second.node_idx = new_node_idx;
                eit->second.payload_json = payload_json;
                eit->second.expires_at = expires_at;
                // Promote to MRU
                auto lpos = shard.lru_pos.find(entry_id);
                if (lpos != shard.lru_pos.end()) {
                    shard.lru_list.erase(lpos->second);
                }
                shard.lru_list.push_front(entry_id);
                shard.lru_pos[entry_id] = shard.lru_list.begin();
            }
        } else {
            const uint32_t seq = next_seq_.fetch_add(1, std::memory_order_relaxed);
            entry_id = (seq << 4) | shard_idx;
            CacheEntry entry;
            entry.entry_id = entry_id;
            entry.node_idx = new_node_idx;
            entry.key = key;
            entry.payload_json = payload_json;
            entry.expires_at = expires_at;
            entry.hit_count = 0;

            shard.entries.emplace(entry_id, std::move(entry));
            shard.key_to_id.emplace(key, entry_id);
            shard.lru_list.push_front(entry_id);
            shard.lru_pos[entry_id] = shard.lru_list.begin();
            active_entries_.fetch_add(1, std::memory_order_relaxed);
        }
    }

    HnswNode node;
    node.entry_id = entry_id;
    node.level = sample_level();
    node.tombstoned = false;
    node.key_preview = key.substr(0, std::min<size_t>(key.size(), 72));
    node.vec = std::move(norm_vec);
    node.proj_3d = proj_3d;

    nodes_.push_back(std::move(node));
    insert_node_locked(new_node_idx);

    if (nodes_.size() > 64 && tombstone_count_ * 100 > nodes_.size() * 35) {
        compact_locked();
    }

    return static_cast<int32_t>(entry_id);
}

CacheSearchResult HnswSemanticCache::search(
    const float* vec,
    uint32_t dim,
    float threshold,
    uint32_t top_k
) {
    const auto t0 = std::chrono::steady_clock::now();
    CacheSearchResult res;
    if (!vec || dim != cfg_.vector_dim) {
        misses_.fetch_add(1, std::memory_order_relaxed);
        return res;
    }
    if (top_k == 0) top_k = 3;

    const auto q = normalize_vector(vec, dim);
    const auto now = std::chrono::steady_clock::now();

    std::shared_lock<std::shared_mutex> glock(graph_mu_);
    if (entry_point_ < 0 || nodes_.empty()) {
        const auto t1 = std::chrono::steady_clock::now();
        res.search_us = std::chrono::duration<double, std::micro>(t1 - t0).count();
        misses_.fetch_add(1, std::memory_order_relaxed);
        return res;
    }

    uint32_t curr = static_cast<uint32_t>(entry_point_);
    uint32_t hops = 0;

    for (int l = max_level_; l >= 1; --l) {
        curr = greedy_descent_locked(q.data(), curr, l, hops, &res.hop_trace);
    }

    const uint32_t ef = std::max(cfg_.ef_search, top_k * 4);
    auto raw_candidates = search_layer_locked(q.data(), curr, 0, ef, hops, &res.hop_trace);
    res.hops_evaluated = hops;

    for (const auto& [sim, node_idx] : raw_candidates) {
        if (node_idx >= nodes_.size() || nodes_[node_idx].tombstoned) continue;
        const uint32_t eid = nodes_[node_idx].entry_id;
        const uint32_t s = shard_for_id(eid);

        std::lock_guard<std::mutex> slock(shards_[s].mu);
        auto it = shards_[s].entries.find(eid);
        if (it == shards_[s].entries.end()) continue;

        if (now >= it->second.expires_at) {
            // Lazy TTL expiration inside shard
            auto lpos = shards_[s].lru_pos.find(eid);
            if (lpos != shards_[s].lru_pos.end()) {
                shards_[s].lru_list.erase(lpos->second);
                shards_[s].lru_pos.erase(lpos);
            }
            shards_[s].key_to_id.erase(it->second.key);
            shards_[s].entries.erase(it);
            active_entries_.fetch_sub(1, std::memory_order_relaxed);
            expirations_.fetch_add(1, std::memory_order_relaxed);
            continue;
        }

        SearchCandidate cand;
        cand.entry_id = eid;
        cand.node_idx = node_idx;
        cand.similarity = sim;
        cand.key_preview = nodes_[node_idx].key_preview;
        cand.payload_json = it->second.payload_json;
        res.candidates.push_back(std::move(cand));

        if (!res.hit && sim >= threshold) {
            res.hit = true;
            res.similarity = sim;
            res.entry_id = static_cast<int32_t>(eid);
            res.payload_json = it->second.payload_json;
            it->second.hit_count++;

            // Promote to MRU
            auto lpos = shards_[s].lru_pos.find(eid);
            if (lpos != shards_[s].lru_pos.end()) {
                shards_[s].lru_list.erase(lpos->second);
            }
            shards_[s].lru_list.push_front(eid);
            shards_[s].lru_pos[eid] = shards_[s].lru_list.begin();
        }

        if (res.candidates.size() >= top_k) break;
    }

    if (!res.hit && !res.candidates.empty()) {
        res.similarity = res.candidates.front().similarity;
    }

    if (res.hit) {
        hits_.fetch_add(1, std::memory_order_relaxed);
    } else {
        misses_.fetch_add(1, std::memory_order_relaxed);
    }

    const auto t1 = std::chrono::steady_clock::now();
    const uint64_t ns = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count()
    );
    total_search_ns_.fetch_add(ns, std::memory_order_relaxed);
    total_searches_.fetch_add(1, std::memory_order_relaxed);
    res.search_us = static_cast<double>(ns) / 1000.0;
    return res;
}

float HnswSemanticCache::brute_force_best_similarity(const float* vec, uint32_t dim) const {
    if (!vec || dim != cfg_.vector_dim) return 0.0f;
    const auto q = normalize_vector(vec, dim);
    std::shared_lock<std::shared_mutex> glock(graph_mu_);
    float best = -1.0f;
    for (const auto& node : nodes_) {
        if (node.tombstoned) continue;
        const float sim = dot_product(q.data(), node.vec.data(), dim);
        if (sim > best) best = sim;
    }
    return best;
}

void HnswSemanticCache::clear() {
    std::unique_lock<std::shared_mutex> glock(graph_mu_);
    for (uint32_t s = 0; s < kNumShards; ++s) {
        std::lock_guard<std::mutex> slock(shards_[s].mu);
        shards_[s].lru_list.clear();
        shards_[s].lru_pos.clear();
        shards_[s].entries.clear();
        shards_[s].key_to_id.clear();
    }
    nodes_.clear();
    entry_point_ = -1;
    max_level_ = -1;
    tombstone_count_ = 0;
    active_entries_.store(0, std::memory_order_relaxed);
}

std::string HnswSemanticCache::graph_snapshot_json(uint32_t max_nodes) const {
    std::shared_lock<std::shared_mutex> glock(graph_mu_);
    if (max_nodes == 0) max_nodes = 128;

    std::ostringstream oss;
    oss << "{\"max_level\":" << max_level_ << ",\"entry_point\":" << entry_point_ << ",\"nodes\":[";

    std::unordered_set<uint32_t> included;
    uint32_t emitted = 0;
    for (uint32_t i = 0; i < nodes_.size() && emitted < max_nodes; ++i) {
        if (nodes_[i].tombstoned) continue;
        if (emitted > 0) oss << ',';
        included.insert(i);
        const auto& n = nodes_[i];
        oss << "{\"node_idx\":" << i << ","
            << "\"entry_id\":" << n.entry_id << ","
            << "\"shard\":" << shard_for_id(n.entry_id) << ","
            << "\"level\":" << n.level << ","
            << "\"key_preview\":\"" << json::escape(n.key_preview) << "\","
            << "\"pos\":[" << n.proj_3d[0] << "," << n.proj_3d[1] << "," << n.proj_3d[2] << "]}";
        emitted++;
    }
    oss << "],\"edges\":[";

    bool first_edge = true;
    for (uint32_t idx : included) {
        const auto& n = nodes_[idx];
        for (size_t lvl = 0; lvl < n.neighbors.size(); ++lvl) {
            for (uint32_t nb : n.neighbors[lvl]) {
                if (idx < nb && included.count(nb)) {
                    if (!first_edge) oss << ',';
                    first_edge = false;
                    oss << "{\"from\":" << idx << ",\"to\":" << nb << ",\"level\":" << lvl << "}";
                }
            }
        }
    }
    oss << "]}";
    return oss.str();
}

std::string HnswSemanticCache::stats_json() const {
    std::shared_lock<std::shared_mutex> glock(graph_mu_);
    uint64_t edge_count = 0;
    for (const auto& n : nodes_) {
        if (n.tombstoned) continue;
        for (const auto& lvl_nbs : n.neighbors) {
            edge_count += lvl_nbs.size();
        }
    }
    const uint64_t searches = total_searches_.load(std::memory_order_relaxed);
    const uint64_t ns = total_search_ns_.load(std::memory_order_relaxed);
    const double avg_us = (searches > 0) ? (static_cast<double>(ns) / searches / 1000.0) : 0.0;

    std::ostringstream oss;
    oss << "{\"vector_dim\":" << cfg_.vector_dim << ","
        << "\"max_entries\":" << cfg_.max_entries << ","
        << "\"shards\":" << kNumShards << ","
        << "\"active_entries\":" << active_entries_.load(std::memory_order_relaxed) << ","
        << "\"total_nodes\":" << nodes_.size() << ","
        << "\"tombstones\":" << tombstone_count_ << ","
        << "\"hits\":" << hits_.load(std::memory_order_relaxed) << ","
        << "\"misses\":" << misses_.load(std::memory_order_relaxed) << ","
        << "\"evictions\":" << evictions_.load(std::memory_order_relaxed) << ","
        << "\"expirations\":" << expirations_.load(std::memory_order_relaxed) << ","
        << "\"avg_search_us\":" << avg_us << ","
        << "\"hnsw_levels\":" << (max_level_ + 1) << ","
        << "\"hnsw_edges\":" << (edge_count / 2) << "}";
    return oss.str();
}

std::string HnswSemanticCache::search_result_to_json(const CacheSearchResult& res) {
    std::ostringstream oss;
    oss << "{\"hit\":" << (res.hit ? "true" : "false") << ","
        << "\"similarity\":" << res.similarity << ","
        << "\"entry_id\":" << res.entry_id << ","
        << "\"hops_evaluated\":" << res.hops_evaluated << ","
        << "\"search_us\":" << res.search_us << ","
        << "\"payload_json\":\"" << json::escape(res.payload_json) << "\","
        << "\"candidates\":[";
    for (size_t i = 0; i < res.candidates.size(); ++i) {
        const auto& c = res.candidates[i];
        if (i > 0) oss << ',';
        oss << "{\"entry_id\":" << c.entry_id << ","
            << "\"node_idx\":" << c.node_idx << ","
            << "\"similarity\":" << c.similarity << ","
            << "\"key_preview\":\"" << json::escape(c.key_preview) << "\"}";
    }
    oss << "],\"hop_trace\":[";
    for (size_t i = 0; i < res.hop_trace.size(); ++i) {
        const auto& h = res.hop_trace[i];
        if (i > 0) oss << ',';
        oss << "{\"node_idx\":" << h.node_idx << ","
            << "\"level\":" << h.level << ","
            << "\"similarity\":" << h.similarity << "}";
    }
    oss << "]}";
    return oss.str();
}

}  // namespace aegis
