from __future__ import annotations

import hashlib
import os
import re
from typing import Iterable

import httpx
import numpy as np

_STOPWORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "to", "of", "in", "on", "for", "with", "at", "by", "from", "as",
    "into", "about", "like", "through", "after", "over", "between",
    "do", "does", "did", "can", "could", "would", "should", "will",
    "how", "what", "why", "when", "where", "which", "who", "whom",
    "i", "me", "my", "you", "your", "we", "our", "it", "its", "this", "that",
    "and", "or", "but", "if", "so", "than", "then", "there", "please",
    "give", "tell", "show", "steps", "way", "ways", "simple", "terms",
})

_SYNONYM_MAP = {
    "k8s": "kubernetes",
    "kube": "kubernetes",
    "pods": "pod",
    "containers": "container",
    "reboot": "restart",
    "reset": "restart",
    "recycle": "restart",
    "restarting": "restart",
    "crashed": "crash",
    "crashing": "crash",
    "failing": "crash",
    "failed": "crash",
    "unhealthy": "crash",
    "pg": "postgresql",
    "postgres": "postgresql",
    "db": "database",
    "databases": "database",
    "gil": "global interpreter lock",
    "mutexes": "mutex",
    "locks": "lock",
    "locking": "lock",
    "threads": "thread",
    "threading": "thread",
    "multithreading": "thread",
    "concurrency": "thread",
    "concurrent": "thread",
    "cached": "cache",
    "caching": "cache",
    "vectors": "vector",
    "embeddings": "embedding",
    "embed": "embedding",
    "breakers": "breaker",
    "failover": "fallback",
    "reroute": "fallback",
    "throttling": "ratelimit",
    "throttle": "ratelimit",
    "ratelimiting": "ratelimit",
    "latency": "speed",
    "fast": "speed",
    "faster": "speed",
    "optimize": "tuning",
    "optimization": "tuning",
    "tune": "tuning",
    "explain": "overview",
    "describe": "overview",
    "summarize": "overview",
    "summary": "overview",
    "work": "mechanism",
    "works": "mechanism",
    "working": "mechanism",
    "redact": "scrub",
    "redaction": "scrub",
    "sanitize": "scrub",
    "pii": "secret",
    "secrets": "secret",
    "credentials": "secret",
}

_TOKEN_RE = re.compile(r"[a-z0-9_+#.-]+")


def _canonical_tokens(text: str) -> list[str]:
    cleaned = re.sub(r"'s\b", "", text.lower())
    raw = _TOKEN_RE.findall(cleaned)
    out: list[str] = []
    for tok in raw:
        tok = tok.strip(".-_")
        if not tok or tok in _STOPWORDS:
            continue
        mapped = _SYNONYM_MAP.get(tok, tok)
        for part in mapped.split():
            if part and part not in _STOPWORDS:
                out.append(part)
    return out


def _hash_feature(feature: str, seed: int) -> tuple[int, float]:
    digest = hashlib.blake2b(f"{seed}:{feature}".encode("utf-8"), digest_size=8).digest()
    val = int.from_bytes(digest, "little", signed=False)
    idx = val >> 1
    sign = 1.0 if (val & 1) == 0 else -1.0
    return idx, sign


class SemanticEmbedder:
    """Zero-dependency local subword+synonym semantic embedder with optional OpenAI/Ollama backends."""

    def __init__(self, dim: int = 256, provider: str | None = None) -> None:
        self.dim = dim
        self.provider = (provider or os.environ.get("AEGIS_EMBED_PROVIDER", "local-hybrid")).lower()
        self.openai_api_key = os.environ.get("OPENAI_API_KEY", "")
        self.openai_base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
        self.ollama_url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")

    def _project_local(self, text: str) -> np.ndarray:
        vec = np.zeros(self.dim, dtype=np.float32)
        tokens = _canonical_tokens(text)
        if not tokens:
            tokens = ["empty"]

        def add_feature(feat: str, weight: float) -> None:
            for s in (11, 37, 73):
                h, sign = _hash_feature(feat, s)
                vec[h % self.dim] += sign * weight

        # Word unigrams (primary semantic signal)
        for tok in tokens:
            add_feature(f"w:{tok}", 2.5)
            # Subword 3-grams and 4-grams for morphological similarity
            if len(tok) >= 4:
                padded = f"<{tok}>"
                for n in (3, 4):
                    for i in range(len(padded) - n + 1):
                        add_feature(f"c{n}:{padded[i:i+n]}", 0.45)

        # Canonical word bigrams
        for i in range(len(tokens) - 1):
            add_feature(f"bg:{tokens[i]}_{tokens[i+1]}", 1.75)

        # Unordered co-occurrence skip-pairs within short window
        for i in range(len(tokens)):
            for j in range(i + 1, min(i + 4, len(tokens))):
                a, b = sorted((tokens[i], tokens[j]))
                add_feature(f"sk:{a}+{b}", 0.9)

        norm = float(np.linalg.norm(vec))
        if norm > 1e-8:
            vec /= norm
        return np.ascontiguousarray(vec, dtype=np.float32)

    async def embed(self, text: str) -> np.ndarray:
        if self.provider == "openai" and self.openai_api_key:
            try:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    resp = await client.post(
                        f"{self.openai_base_url.rstrip('/')}/embeddings",
                        headers={"Authorization": f"Bearer {self.openai_api_key}"},
                        json={
                            "model": os.environ.get("AEGIS_OPENAI_EMBED_MODEL", "text-embedding-3-small"),
                            "input": text,
                            "dimensions": self.dim,
                        },
                    )
                    resp.raise_for_status()
                    data = resp.json()["data"][0]["embedding"]
                    arr = np.asarray(data[: self.dim], dtype=np.float32)
                    norm = float(np.linalg.norm(arr))
                    return (arr / norm) if norm > 1e-8 else arr
            except Exception:
                pass
        elif self.provider == "ollama":
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.post(
                        f"{self.ollama_url.rstrip('/')}/api/embeddings",
                        json={"model": os.environ.get("AEGIS_OLLAMA_EMBED_MODEL", "nomic-embed-text"), "prompt": text},
                    )
                    resp.raise_for_status()
                    data = resp.json()["embedding"]
                    arr = np.asarray(data[: self.dim], dtype=np.float32)
                    if arr.shape[0] < self.dim:
                        arr = np.pad(arr, (0, self.dim - arr.shape[0]))
                    norm = float(np.linalg.norm(arr))
                    return (arr / norm) if norm > 1e-8 else arr
            except Exception:
                pass

        return self._project_local(text)

    def embed_sync(self, text: str) -> np.ndarray:
        return self._project_local(text)

    def embed_batch_sync(self, texts: Iterable[str]) -> list[np.ndarray]:
        return [self._project_local(t) for t in texts]
