from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable


class CircuitState(str, Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


@dataclass
class CircuitEvent:
    timestamp: float
    provider: str
    from_state: str
    to_state: str
    reason: str


@dataclass
class SlidingWindowCircuitBreaker:
    """3-state sliding-window circuit breaker with half-open recovery probes."""

    provider: str
    window_size: int = 10
    failure_rate_threshold: float = 0.5
    consecutive_failures_trip: int = 3
    cooldown_sec: float = 12.0
    half_open_success_required: int = 2
    on_transition: Callable[[CircuitEvent], None] | None = None

    state: CircuitState = CircuitState.CLOSED
    opened_at: float = 0.0
    consecutive_failures: int = 0
    half_open_successes: int = 0
    window: deque[bool] = field(default_factory=deque)
    total_trips: int = 0
    last_reason: str = "healthy"

    def _transition(self, target: CircuitState, reason: str) -> None:
        if self.state == target:
            return
        evt = CircuitEvent(
            timestamp=time.time(),
            provider=self.provider,
            from_state=self.state.value,
            to_state=target.value,
            reason=reason,
        )
        self.state = target
        self.last_reason = reason
        if target == CircuitState.OPEN:
            self.opened_at = time.monotonic()
            self.half_open_successes = 0
            self.total_trips += 1
        elif target == CircuitState.HALF_OPEN:
            self.half_open_successes = 0
        elif target == CircuitState.CLOSED:
            self.consecutive_failures = 0
            self.half_open_successes = 0
            self.window.clear()
        if self.on_transition:
            self.on_transition(evt)

    def allow_request(self) -> bool:
        if self.state == CircuitState.CLOSED:
            return True
        if self.state == CircuitState.OPEN:
            if (time.monotonic() - self.opened_at) >= self.cooldown_sec:
                self._transition(CircuitState.HALF_OPEN, "cooldown_elapsed_probe")
                return True
            return False
        # HALF_OPEN allows bounded probe traffic
        return True

    def record_success(self) -> None:
        self.consecutive_failures = 0
        self.window.append(True)
        if len(self.window) > self.window_size:
            self.window.popleft()

        if self.state == CircuitState.HALF_OPEN:
            self.half_open_successes += 1
            if self.half_open_successes >= self.half_open_success_required:
                self._transition(CircuitState.CLOSED, "half_open_probes_passed")
        else:
            self.last_reason = "healthy"

    def record_failure(self, reason: str) -> None:
        self.consecutive_failures += 1
        self.window.append(False)
        if len(self.window) > self.window_size:
            self.window.popleft()

        if self.state == CircuitState.HALF_OPEN:
            self._transition(CircuitState.OPEN, f"half_open_probe_failed:{reason}")
            return

        fail_count = sum(1 for ok in self.window if not ok)
        fail_rate = fail_count / len(self.window) if self.window else 0.0
        if self.consecutive_failures >= self.consecutive_failures_trip or (
            len(self.window) >= max(4, self.window_size // 2)
            and fail_rate >= self.failure_rate_threshold
        ):
            self._transition(
                CircuitState.OPEN,
                f"{reason} (consec={self.consecutive_failures}, rate={fail_rate:.2f})",
            )

    def force_reset(self) -> None:
        self._transition(CircuitState.CLOSED, "manual_reset")

    def snapshot(self) -> dict:
        cooldown_rem = 0.0
        if self.state == CircuitState.OPEN:
            cooldown_rem = max(0.0, self.cooldown_sec - (time.monotonic() - self.opened_at))
        fail_count = sum(1 for ok in self.window if not ok)
        return {
            "provider": self.provider,
            "state": self.state.value,
            "consecutive_failures": self.consecutive_failures,
            "window_failures": fail_count,
            "window_size": len(self.window),
            "cooldown_remaining_sec": round(cooldown_rem, 2),
            "total_trips": self.total_trips,
            "last_reason": self.last_reason,
        }
