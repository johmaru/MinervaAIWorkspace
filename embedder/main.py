"""
UmansChat embedder — FastAPI service for sentence-transformers embedding models.

Supports multiple models with model-aware prefix/pooling configuration:
- LiquidAI/LFM2.5-Embedding-350M: prompt_name="query"/"document", CLS→mean pooling fix
- cl-nagoya/ruri-v3-310m: text prefix "検索クエリ:"/"検索文書:", native mean pooling
- Other models: plain text (no prefix, no prompt_name)

Startup:
  uvicorn main:app --host 0.0.0.0 --port 8001

Environment variables:
  EMBEDDER_MODEL  default LiquidAI/LFM2.5-Embedding-350M
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

EMBEDDER_MODEL = os.environ.get("EMBEDDER_MODEL", "LiquidAI/LFM2.5-Embedding-350M")

# Model-aware configuration: prefix scheme and pooling behavior.
# - "text_prefix": prepend fixed strings before encoding (ruri-v3 style).
# - "prompt_name": use sentence-transformers prompt_name API (LFM2.5 style).
# - None: plain text, no prefix (Xenova-compatible fallback).
MODEL_CONFIGS: dict[str, dict] = {
    "ruri-v3": {
        "prefix_scheme": "text_prefix",
        "query_prefix": "検索クエリ: ",
        "document_prefix": "検索文書: ",
        "needs_pooling_fix": False,  # ruri-v3 uses mean pooling natively
    },
    "lfm2.5": {
        "prefix_scheme": "prompt_name",
        "query_prefix": None,
        "document_prefix": None,
        "needs_pooling_fix": True,  # LFM2.5 CLS token produces constant vectors
    },
    "default": {
        "prefix_scheme": None,
        "query_prefix": None,
        "document_prefix": None,
        "needs_pooling_fix": False,
    },
}


def get_model_config(model_id: str) -> dict:
    """Return model-specific config based on model_id substring matching."""
    model_lower = model_id.lower()
    if "ruri" in model_lower:
        return MODEL_CONFIGS["ruri-v3"]
    if "lfm" in model_lower:
        return MODEL_CONFIGS["lfm2.5"]
    return MODEL_CONFIGS["default"]


# Flag for returning 503 for requests made before the model finishes loading.
# Set to True by lifespan once loading completes.
_model: dict = {"ready": False, "transformer": None, "config": get_model_config(EMBEDDER_MODEL)}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # The initial load of sentence-transformers includes a model download
    # (~700MB), so it takes time. /health returns "loading" while loading.
    from sentence_transformers import SentenceTransformer

    model_config = get_model_config(EMBEDDER_MODEL)
    transformer = SentenceTransformer(EMBEDDER_MODEL)

    # LFM2.5-Embedding-350M ships with CLS-token pooling by default, but its
    # CLS token (position 0) produces a constant vector regardless of input
    # content — making every text embed to the same point. Switch to mean
    # pooling, which correctly reflects per-token semantic differences.
    # Only applies to LFM2.5; ruri-v3 and others use native pooling.
    if model_config["needs_pooling_fix"]:
        pooling = transformer[1]
        pooling.pooling_mode_cls_token = False
        pooling.pooling_mode_mean_tokens = True

    # Startup self-test: embed two distinct probe strings and verify they
    # produce different vectors. Catches degenerate model configs (e.g.,
    # CLS-pooling returning a position-0 constant) before serving requests.
    import numpy as np

    probe = transformer.encode(
        ["startup probe alpha", "startup probe beta zeta gamma"],
        normalize_embeddings=True,
    )
    if np.array_equal(probe[0], probe[1]):
        raise RuntimeError(
            "Embedding self-test failed: two distinct inputs produced "
            "identical vectors. The model configuration is degenerate."
        )

    _model["transformer"] = transformer
    _model["config"] = model_config
    _model["ready"] = True
    yield
    # Release on shutdown (explicit close is not required)


app = FastAPI(lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str]
    kind: Literal["query", "document"] | None = None


class EmbedResponse(BaseModel):
    vectors: list[list[float]]


@app.get("/health")
def health() -> dict:
    return {"status": "ready" if _model["ready"] else "loading"}


@app.post("/embed")
def embed(req: EmbedRequest) -> EmbedResponse:
    if not _model["ready"] or _model["transformer"] is None:
        # Before lifespan completes. Model is still loading.
        from fastapi import HTTPException

        raise HTTPException(status_code=503, detail={"error": "model_loading"})

    transformer = _model["transformer"]
    model_config = _model["config"]
    texts = req.texts

    # Apply prefix based on model configuration and kind.
    # ruri-v3 uses text prefixes ("検索クエリ: " / "検索文書: ").
    # LFM2.5 uses sentence-transformers prompt_name API.
    # Other models: no prefix.
    encode_kwargs: dict = {}
    if req.kind is not None:
        prefix_scheme = model_config["prefix_scheme"]
        if prefix_scheme == "text_prefix":
            prefix = model_config["query_prefix"] if req.kind == "query" else model_config["document_prefix"]
            if prefix:
                texts = [f"{prefix}{t}" for t in texts]
        elif prefix_scheme == "prompt_name":
            encode_kwargs["prompt_name"] = req.kind

    # normalize_embeddings=True normalizes for cosine similarity.
    # sentence-transformers handles batching internally.
    vectors = transformer.encode(
        texts,
        normalize_embeddings=True,
        **encode_kwargs,
    )
    return EmbedResponse(vectors=vectors.tolist())
