"""
UmansChat embedder — FastAPI service for LFM2.5-Embedding-350M.

Applies the prompts (`query:` / `document:`) from `config_sentence_transformers.json`
via sentence-transformers 5.x's `prompt_name` API. When `kind` is omitted, plain
text is used (Xenova-compatible).

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

# Flag for returning 503 for requests made before the model finishes loading.
# Set to True by lifespan once loading completes.
_model: dict = {"ready": False, "transformer": None}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # The initial load of sentence-transformers includes a model download
    # (~700MB), so it takes time. /health returns "loading" while loading.
    from sentence_transformers import SentenceTransformer

    _model["transformer"] = SentenceTransformer(EMBEDDER_MODEL)
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
    # When kind is provided, apply the config prompts via prompt_name.
    # When omitted, use plain text (prompt_name=None).
    encode_kwargs: dict = {}
    if req.kind is not None:
        encode_kwargs["prompt_name"] = req.kind

    # normalize_embeddings=True normalizes for cosine similarity.
    # sentence-transformers handles batching internally.
    vectors = transformer.encode(
        req.texts,
        normalize_embeddings=True,
        **encode_kwargs,
    )
    return EmbedResponse(vectors=vectors.tolist())
