from __future__ import annotations

import ctypes
import json
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np


class AegisEngineConfig(ctypes.Structure):
    _fields_ = [
        ("vector_dim", ctypes.c_uint32),
        ("max_entries", ctypes.c_uint32),
        ("hnsw_m", ctypes.c_uint32),
        ("ef_construction", ctypes.c_uint32),
        ("ef_search", ctypes.c_uint32),
        ("default_ttl_sec", ctypes.c_uint32),
        ("rate_limit_capacity", ctypes.c_float),
        ("rate_limit_refill_per_sec", ctypes.c_float),
    ]


def _default_lib_path() -> Path:
    root = Path(__file__).resolve().parent.parent / "cpp_core" / "build"
    if sys.platform.startswith("win"):
        candidates = [root / "aegis_core.dll", root / "Release" / "aegis_core.dll"]
    elif sys.platform == "darwin":
        candidates = [root / "libaegis_core.dylib"]
    else:
        candidates = [root / "libaegis_core.so"]
    for p in candidates:
        if p.exists():
            return p
    raise FileNotFoundError(
        f"Compiled C++20 core library not found in {root}. "
        "Run cpp_core/build.ps1 (Windows) or cmake --build (Linux/macOS)."
    )


class CppCoreBridge:
    """Thread-safe ctypes FFI wrapper over the compiled C++20 AegisKV engine.

    Note: ctypes.CDLL releases the Python GIL during every native C-ABI call,
    allowing concurrent FastAPI async threads to execute HNSW lookups and
    guardrail scans in parallel across C++20 shared_mutex shards.
    """

    def __init__(
        self,
        vector_dim: int = 256,
        max_entries: int = 10000,
        hnsw_m: int = 16,
        ef_construction: int = 64,
        ef_search: int = 32,
        default_ttl_sec: int = 3600,
        rate_limit_capacity: float = 25.0,
        rate_limit_refill_per_sec: float = 5.0,
        lib_path: str | Path | None = None,
    ) -> None:
        resolved = Path(lib_path) if lib_path else Path(os.environ.get("AEGIS_LIB_PATH") or _default_lib_path())
        self._lib = ctypes.CDLL(str(resolved))
        self._bind_signatures()
        self.vector_dim = vector_dim

        cfg = AegisEngineConfig(
            vector_dim=vector_dim,
            max_entries=max_entries,
            hnsw_m=hnsw_m,
            ef_construction=ef_construction,
            ef_search=ef_search,
            default_ttl_sec=default_ttl_sec,
            rate_limit_capacity=rate_limit_capacity,
            rate_limit_refill_per_sec=rate_limit_refill_per_sec,
        )
        self._handle = self._lib.aegis_engine_create(ctypes.byref(cfg))
        if not self._handle:
            raise RuntimeError("Failed to initialize C++20 AegisEngine instance")

    def _bind_signatures(self) -> None:
        lib = self._lib
        lib.aegis_engine_create.argtypes = [ctypes.POINTER(AegisEngineConfig)]
        lib.aegis_engine_create.restype = ctypes.c_void_p

        lib.aegis_engine_destroy.argtypes = [ctypes.c_void_p]
        lib.aegis_engine_destroy.restype = None

        lib.aegis_cache_upsert.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_float),
            ctypes.c_uint32,
            ctypes.c_char_p,
            ctypes.c_uint32,
        ]
        lib.aegis_cache_upsert.restype = ctypes.c_int32

        lib.aegis_cache_search.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_float),
            ctypes.c_uint32,
            ctypes.c_float,
            ctypes.c_uint32,
        ]
        lib.aegis_cache_search.restype = ctypes.c_void_p

        lib.aegis_cache_clear.argtypes = [ctypes.c_void_p]
        lib.aegis_cache_clear.restype = None

        lib.aegis_cache_graph_snapshot.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        lib.aegis_cache_graph_snapshot.restype = ctypes.c_void_p

        lib.aegis_guardrail_scan.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        lib.aegis_guardrail_scan.restype = ctypes.c_void_p

        lib.aegis_ratelimit_allow.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_float]
        lib.aegis_ratelimit_allow.restype = ctypes.c_void_p

        lib.aegis_engine_stats.argtypes = [ctypes.c_void_p]
        lib.aegis_engine_stats.restype = ctypes.c_void_p

        lib.aegis_free_string.argtypes = [ctypes.c_void_p]
        lib.aegis_free_string.restype = None

    def _consume_json(self, ptr: int | None) -> dict[str, Any]:
        if not ptr:
            return {}
        try:
            raw = ctypes.string_at(ptr).decode("utf-8")
            return json.loads(raw)
        finally:
            self._lib.aegis_free_string(ptr)

    def _as_f32_array(self, vec: np.ndarray | list[float]) -> np.ndarray:
        arr = np.asarray(vec, dtype=np.float32)
        if arr.ndim != 1 or arr.shape[0] != self.vector_dim:
            raise ValueError(f"Expected 1D vector of dim {self.vector_dim}, got {arr.shape}")
        if not arr.flags["C_CONTIGUOUS"]:
            arr = np.ascontiguousarray(arr, dtype=np.float32)
        return arr

    def cache_upsert(
        self, key: str, vec: np.ndarray | list[float], payload: dict[str, Any], ttl_sec: int = 3600
    ) -> int:
        arr = self._as_f32_array(vec)
        vec_ptr = arr.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
        payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return int(
            self._lib.aegis_cache_upsert(
                self._handle,
                key.encode("utf-8"),
                vec_ptr,
                self.vector_dim,
                payload_bytes,
                int(ttl_sec),
            )
        )

    def cache_search(
        self, vec: np.ndarray | list[float], threshold: float = 0.84, top_k: int = 3
    ) -> dict[str, Any]:
        arr = self._as_f32_array(vec)
        vec_ptr = arr.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
        ptr = self._lib.aegis_cache_search(
            self._handle, vec_ptr, self.vector_dim, float(threshold), int(top_k)
        )
        res = self._consume_json(ptr)
        if res.get("payload_json"):
            try:
                res["payload"] = json.loads(res["payload_json"])
            except json.JSONDecodeError:
                res["payload"] = {"raw": res["payload_json"]}
        else:
            res["payload"] = None
        return res

    def cache_clear(self) -> None:
        self._lib.aegis_cache_clear(self._handle)

    def graph_snapshot(self, max_nodes: int = 128) -> dict[str, Any]:
        ptr = self._lib.aegis_cache_graph_snapshot(self._handle, int(max_nodes))
        return self._consume_json(ptr)

    def guardrail_scan(self, text: str) -> dict[str, Any]:
        ptr = self._lib.aegis_guardrail_scan(self._handle, text.encode("utf-8"))
        return self._consume_json(ptr)

    def ratelimit_allow(self, tenant_id: str, cost: float = 1.0) -> dict[str, Any]:
        ptr = self._lib.aegis_ratelimit_allow(
            self._handle, tenant_id.encode("utf-8"), float(cost)
        )
        return self._consume_json(ptr)

    def stats(self) -> dict[str, Any]:
        ptr = self._lib.aegis_engine_stats(self._handle)
        return self._consume_json(ptr)

    def close(self) -> None:
        if getattr(self, "_handle", None):
            self._lib.aegis_engine_destroy(self._handle)
            self._handle = None

    def __del__(self) -> None:
        self.close()
