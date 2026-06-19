"""
UmansChat embedder — LFM2.5-Embedding-350M 用 FastAPI サービス。

sentence-transformers 5.x の `prompt_name` API を介して
`config_sentence_transformers.json` の prompts（`query:` / `document:`）
を適用する。`kind` 省略時は素テキスト（Xenova 互換）。

起動:
  uvicorn main:app --host 0.0.0.0 --port 8001

環境変数:
  EMBEDDER_MODEL  デフォ LiquidAI/LFM2.5-Embedding-350M
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

EMBEDDER_MODEL = os.environ.get("EMBEDDER_MODEL", "LiquidAI/LFM2.5-Embedding-350M")

# モデルロード完了前のリクエストは 503 で返すためのフラグ。
# lifespan でロード完了後に True になる。
_model: dict = {"ready": False, "transformer": None}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # sentence-transformers の初回ロードはモデルダウンロードを含むため
    # 時間がかかる（~700MB）。ロード中は /health が loading を返す。
    from sentence_transformers import SentenceTransformer

    _model["transformer"] = SentenceTransformer(EMBEDDER_MODEL)
    _model["ready"] = True
    yield
    # シャットダウン時の解放（明示的な close は不要）


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
        # lifespan 完了前。モデルロード中。
        from fastapi import HTTPException

        raise HTTPException(status_code=503, detail={"error": "model_loading"})

    transformer = _model["transformer"]
    # kind 受け取り時は prompt_name で config の prompts を適用。
    # 省略時は素テキスト（prompt_name=None）。
    encode_kwargs: dict = {}
    if req.kind is not None:
        encode_kwargs["prompt_name"] = req.kind

    # normalize_embeddings=True でコサイン類似度用に正規化。
    # sentence-transformers 側がバッチ化を処理する。
    vectors = transformer.encode(
        req.texts,
        normalize_embeddings=True,
        **encode_kwargs,
    )
    return EmbedResponse(vectors=vectors.tolist())
