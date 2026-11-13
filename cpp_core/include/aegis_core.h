#pragma once

#include <cstdint>

#ifdef _WIN32
  #ifdef AEGIS_CORE_EXPORTS
    #define AEGIS_API __declspec(dllexport)
  #else
    #define AEGIS_API __declspec(dllimport)
  #endif
#else
  #define AEGIS_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct AegisEngineConfig {
    uint32_t vector_dim;
    uint32_t max_entries;
    uint32_t hnsw_m;
    uint32_t ef_construction;
    uint32_t ef_search;
    uint32_t default_ttl_sec;
    float rate_limit_capacity;
    float rate_limit_refill_per_sec;
} AegisEngineConfig;

AEGIS_API void* aegis_engine_create(const AegisEngineConfig* config);
AEGIS_API void aegis_engine_destroy(void* engine);

AEGIS_API int32_t aegis_cache_upsert(
    void* engine,
    const char* key,
    const float* vec,
    uint32_t dim,
    const char* payload_json,
    uint32_t ttl_sec
);

AEGIS_API const char* aegis_cache_search(
    void* engine,
    const float* vec,
    uint32_t dim,
    float threshold,
    uint32_t top_k
);

AEGIS_API void aegis_cache_clear(void* engine);

AEGIS_API const char* aegis_cache_graph_snapshot(
    void* engine,
    uint32_t max_nodes
);

AEGIS_API const char* aegis_guardrail_scan(
    void* engine,
    const char* text
);

AEGIS_API const char* aegis_ratelimit_allow(
    void* engine,
    const char* tenant_id,
    float cost
);

AEGIS_API const char* aegis_engine_stats(void* engine);

AEGIS_API void aegis_free_string(const char* ptr);

#ifdef __cplusplus
}
#endif
