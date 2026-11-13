#ifndef AEGIS_CORE_EXPORTS
#define AEGIS_CORE_EXPORTS
#endif
#include "aegis_core.h"

#include "guardrail.hpp"
#include "hnsw_cache.hpp"
#include "json_util.hpp"
#include "ratelimit.hpp"

#include <memory>
#include <sstream>
#include <string>

namespace {

struct EngineContext {
    aegis::HnswSemanticCache cache;
    aegis::GuardrailScanner guardrail;
    aegis::TokenBucketLimiter limiter;

    EngineContext(const aegis::CacheConfig& cfg, float cap, float refill)
        : cache(cfg), limiter(cap, refill) {}
};

EngineContext* as_ctx(void* ptr) {
    return static_cast<EngineContext*>(ptr);
}

}  // namespace

extern "C" {

AEGIS_API void* aegis_engine_create(const AegisEngineConfig* config) {
    aegis::CacheConfig cfg;
    float cap = 25.0f;
    float refill = 5.0f;
    if (config) {
        if (config->vector_dim > 0) cfg.vector_dim = config->vector_dim;
        if (config->max_entries > 0) cfg.max_entries = config->max_entries;
        if (config->hnsw_m > 0) cfg.hnsw_m = config->hnsw_m;
        if (config->ef_construction > 0) cfg.ef_construction = config->ef_construction;
        if (config->ef_search > 0) cfg.ef_search = config->ef_search;
        if (config->default_ttl_sec > 0) cfg.default_ttl_sec = config->default_ttl_sec;
        if (config->rate_limit_capacity > 0.0f) cap = config->rate_limit_capacity;
        if (config->rate_limit_refill_per_sec > 0.0f) refill = config->rate_limit_refill_per_sec;
    }
    return new EngineContext(cfg, cap, refill);
}

AEGIS_API void aegis_engine_destroy(void* engine) {
    delete as_ctx(engine);
}

AEGIS_API int32_t aegis_cache_upsert(
    void* engine,
    const char* key,
    const float* vec,
    uint32_t dim,
    const char* payload_json,
    uint32_t ttl_sec
) {
    auto* ctx = as_ctx(engine);
    if (!ctx || !key || !vec || !payload_json) return -1;
    return ctx->cache.upsert(key, vec, dim, payload_json, ttl_sec);
}

AEGIS_API const char* aegis_cache_search(
    void* engine,
    const float* vec,
    uint32_t dim,
    float threshold,
    uint32_t top_k
) {
    auto* ctx = as_ctx(engine);
    if (!ctx) return aegis::json::alloc_c_str("{\"hit\":false,\"error\":\"null_engine\"}");
    auto res = ctx->cache.search(vec, dim, threshold, top_k);
    return aegis::json::alloc_c_str(aegis::HnswSemanticCache::search_result_to_json(res));
}

AEGIS_API void aegis_cache_clear(void* engine) {
    auto* ctx = as_ctx(engine);
    if (ctx) ctx->cache.clear();
}

AEGIS_API const char* aegis_cache_graph_snapshot(void* engine, uint32_t max_nodes) {
    auto* ctx = as_ctx(engine);
    if (!ctx) return aegis::json::alloc_c_str("{\"nodes\":[],\"edges\":[]}");
    return aegis::json::alloc_c_str(ctx->cache.graph_snapshot_json(max_nodes));
}

AEGIS_API const char* aegis_guardrail_scan(void* engine, const char* text) {
    auto* ctx = as_ctx(engine);
    if (!ctx || !text) return aegis::json::alloc_c_str("{\"action\":\"ALLOW\",\"findings\":[]}");
    auto res = ctx->guardrail.scan(text);
    return aegis::json::alloc_c_str(aegis::GuardrailScanner::to_json(res));
}

AEGIS_API const char* aegis_ratelimit_allow(void* engine, const char* tenant_id, float cost) {
    auto* ctx = as_ctx(engine);
    if (!ctx) return aegis::json::alloc_c_str("{\"allowed\":true}");
    std::string tid = tenant_id ? tenant_id : "default";
    auto d = ctx->limiter.allow(tid, cost > 0.0f ? cost : 1.0f);
    return aegis::json::alloc_c_str(aegis::TokenBucketLimiter::to_json(d));
}

AEGIS_API const char* aegis_engine_stats(void* engine) {
    auto* ctx = as_ctx(engine);
    if (!ctx) return aegis::json::alloc_c_str("{}");
    std::ostringstream oss;
    oss << "{\"cache\":" << ctx->cache.stats_json() << ","
        << "\"guardrail\":{\"total_scans\":" << ctx->guardrail.total_scans() << ","
        << "\"blocks\":" << ctx->guardrail.total_blocks() << ","
        << "\"redactions\":" << ctx->guardrail.total_redactions() << "},"
        << "\"ratelimit\":{\"rejects\":" << ctx->limiter.total_rejects() << "}}";
    return aegis::json::alloc_c_str(oss.str());
}

AEGIS_API void aegis_free_string(const char* ptr) {
    delete[] ptr;
}

}  // extern "C"
