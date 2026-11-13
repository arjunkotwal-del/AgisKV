#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace aegis {

enum class GuardrailAction {
    ALLOW,
    REDACT,
    BLOCK
};

struct GuardrailFinding {
    std::string rule_id;
    std::string category;
    std::string severity;  // "HIGH", "MEDIUM", "LOW"
    size_t offset = 0;
    size_t length = 0;
    std::string preview;
    std::string replacement;
};

struct GuardrailResult {
    GuardrailAction action = GuardrailAction::ALLOW;
    double risk_score = 0.0;
    double scan_us = 0.0;
    std::string sanitized_text;
    std::vector<GuardrailFinding> findings;
};

class GuardrailScanner {
public:
    GuardrailScanner() = default;

    GuardrailResult scan(std::string_view text);

    uint64_t total_scans() const { return total_scans_.load(std::memory_order_relaxed); }
    uint64_t total_blocks() const { return total_blocks_.load(std::memory_order_relaxed); }
    uint64_t total_redactions() const { return total_redactions_.load(std::memory_order_relaxed); }

    static std::string to_json(const GuardrailResult& res);

private:
    std::atomic<uint64_t> total_scans_{0};
    std::atomic<uint64_t> total_blocks_{0};
    std::atomic<uint64_t> total_redactions_{0};
};

}  // namespace aegis
