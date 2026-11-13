#pragma once

#include "json_util.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>

namespace aegis {

struct RateLimitDecision {
    bool allowed = true;
    double remaining_tokens = 0.0;
    double capacity = 0.0;
    double refill_per_sec = 0.0;
    double retry_after_ms = 0.0;
};

class TokenBucketLimiter {
public:
    TokenBucketLimiter(double capacity, double refill_per_sec)
        : capacity_(std::max(1.0, capacity)),
          refill_per_sec_(std::max(0.01, refill_per_sec)) {}

    RateLimitDecision allow(const std::string& tenant_id, double cost) {
        std::lock_guard<std::mutex> lock(mu_);
        const auto now = std::chrono::steady_clock::now();
        auto it = buckets_.find(tenant_id);
        if (it == buckets_.end()) {
            it = buckets_.emplace(tenant_id, Bucket{capacity_, now}).first;
        }
        Bucket& b = it->second;
        const double elapsed_sec = std::chrono::duration<double>(now - b.last_refill).count();
        if (elapsed_sec > 0.0) {
            b.tokens = std::min(capacity_, b.tokens + elapsed_sec * refill_per_sec_);
            b.last_refill = now;
        }

        RateLimitDecision d;
        d.capacity = capacity_;
        d.refill_per_sec = refill_per_sec_;

        if (b.tokens >= cost) {
            b.tokens -= cost;
            d.allowed = true;
            d.remaining_tokens = b.tokens;
            d.retry_after_ms = 0.0;
        } else {
            d.allowed = false;
            d.remaining_tokens = b.tokens;
            const double deficit = cost - b.tokens;
            d.retry_after_ms = (deficit / refill_per_sec_) * 1000.0;
            total_rejects_.fetch_add(1, std::memory_order_relaxed);
        }
        return d;
    }

    uint64_t total_rejects() const { return total_rejects_.load(std::memory_order_relaxed); }

    static std::string to_json(const RateLimitDecision& d) {
        std::ostringstream oss;
        oss << "{\"allowed\":" << (d.allowed ? "true" : "false") << ","
            << "\"remaining_tokens\":" << d.remaining_tokens << ","
            << "\"capacity\":" << d.capacity << ","
            << "\"refill_per_sec\":" << d.refill_per_sec << ","
            << "\"retry_after_ms\":" << d.retry_after_ms << "}";
        return oss.str();
    }

private:
    struct Bucket {
        double tokens;
        std::chrono::steady_clock::time_point last_refill;
    };

    double capacity_;
    double refill_per_sec_;
    std::mutex mu_;
    std::unordered_map<std::string, Bucket> buckets_;
    std::atomic<uint64_t> total_rejects_{0};
};

}  // namespace aegis
