import { createHash } from "crypto";

/**
 * 埋め込み生成のプロバイダ抽象化。
 *
 * 2つのバックエンドを `EMBED_PROVIDER` env で切替:
 *   - `local`（デフォ）: @xenova/transformers で ONNX モデルをローカル実行
 *   - `http`: Python `sentence-transformers` サービス（embedder）に HTTP で委譲
 *
 * `kind`（`"query" | "document"`）は非対称モデル（LFM2.5 など）の prompt prefix
 * 制御用。`http` プロバイダのみが使用し、`local`（Xenova）では無視される。
 */

// 埋め込みモデルは環境変数で切り替え可能。
// 主要候補（transformers.js で動作確認済み）:
//   Xenova/all-MiniLM-L6-v2               (384次元, 英語中心, 高速)
//   Xenova/paraphrase-multilingual-MiniLM-L12-v2 (384次元, 多言語, 推奨: 日本語含む)
//   Xenova/multilingual-e5-small           (384次元, 多言語)
//   Xenova/multilingual-e5-base            (768次元, 多言語, 高精度)
// HTTP プロバイダ（Python embedder サービス）:
//   LiquidAI/LFM2.5-Embedding-350M         (1024次元, 多言語, sentence-transformers)
let MODEL_ID = process.env.EMBED_MODEL || "LiquidAI/LFM2.5-Embedding-350M";
let EMBED_DIM = Number(process.env.EMBED_DIM) || 1024;

type EmbedKind = "query" | "document";

type Pipeline = {
  (texts: string[], options?: { pooling: "mean"; normalize: boolean }): Promise<{
    data: Float32Array | number[][];
    tolist: () => number[][];
  }>;
};

let pipelinePromise: Promise<Pipeline> | null = null;

/**
 * transformers.js パイプラインを遅延初期化。
 * 初回呼び出しでモデルをロード（ダウンロード）する。
 */
async function getPipeline(): Promise<Pipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const transformers = await import("@xenova/transformers");
      // sharp は画像処理用。テキスト embedding には不要。
      // ネイティブバイナリ不足のエラーを回避するため無効化。
      try {
        transformers.env.backends.onnx.wasm.wasmPaths = "";
      } catch {
        // env 設定は失敗しても続行
      }
      // sharp のロードを回避: process.env でフラグを設定
      // transformers.js v2 は sharp の有無を自動検出するが、
      // バンドル版 sharp のビルド失敗を避けるため明示的に無効化
      const { pipeline } = transformers;
      return pipeline("feature-extraction", MODEL_ID, {
        // progress_callback なし（サイレント）
      }) as unknown as Pipeline;
    })();
  }
  return pipelinePromise;
}

/**
 * HTTP プロバイダ（Python embedder）が有効か。
 * `EMBED_PROVIDER=http` または `EMBEDDER_URL` 設定時。
 */
function isHttpProvider(): boolean {
  return process.env.EMBED_PROVIDER === "http";
}
/**
 * HTTP プロバイダでベクトル生成を委譲。
 * embedder の `/embed` に POST し `vectors` を返す。
 * fetch 失敗 / 503（モデルロード中）時は空配列（local と同じ挙動）。
 */
async function embedViaHttp(texts: string[], kind?: EmbedKind): Promise<number[][]> {
  const url = process.env.EMBEDDER_URL;
  if (!url) {
    console.error("[embed] EMBED_PROVIDER=http ですが EMBEDDER_URL 未設定");
    return texts.map(() => []);
  }
  try {
    const res = await fetch(`${url}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts, kind }),
    });
    if (!res.ok) {
      // 503 = モデルロード中。空配列で呼び出し側にスキップさせる。
      console.error(`[embed] embedder HTTP ${res.status}`);
      return texts.map(() => []);
    }
    const data = (await res.json()) as { vectors: number[][] };
    return data.vectors;
  } catch (err) {
    console.error("[embed] embedder fetch failed:", err);
    return texts.map(() => []);
  }
}

/**
 * 設定変更時に呼んで transformers.js パイプラインキャッシュを破棄する
 * （EMBED_MODEL / EMBED_DIM / EMBED_PROVIDER 変更時）。
 * 次回 embedText 呼び出しで新しい設定でパイプラインを再ロードする。
 */
export function resetEmbedPipeline(): void {
  pipelinePromise = null;
  MODEL_ID = process.env.EMBED_MODEL || "LiquidAI/LFM2.5-Embedding-350M";
  EMBED_DIM = Number(process.env.EMBED_DIM) || 1024;
}
/**
 * テキストの contentHash（SHA-256）を計算。
 * 再 embed 回避用。
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * テキストから embedding ベクトルを生成。
 * 正規化済み。次元は EMBED_DIM 参照。
 *
 * `kind` は非対称モデルの prompt prefix 制御用（LFM2.5 は `query:` / `document:`）。
 * HTTP プロバイダのみ使用。`local`（Xenova）では無視される。
 *
 * エラー時は空配列を返す（呼び出し側でスキップ）。
 */
export async function embedText(text: string, kind?: EmbedKind): Promise<number[]> {
  if (!text.trim()) return [];
  if (isHttpProvider()) {
    const [vec] = await embedViaHttp([text], kind);
    return vec ?? [];
  }
  try {
    const extractor = await getPipeline();
    const output = await extractor([text], { pooling: "mean", normalize: true });
    const vectors = output.tolist();
    return vectors[0];
  } catch (err) {
    console.error("[embed] embedding failed:", err);
    return [];
  }
}

/**
 * 複数テキストをバッチ embedding。
 * transformers.js はバッチ入力をサポートするが、
 * メモリ効率のため最大16件ずつ処理する。
 * HTTP プロバイダではバッチ化を embedder 側に委譲。
 */
export async function embedTexts(texts: string[], kind?: EmbedKind): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (isHttpProvider()) {
    return embedViaHttp(texts, kind);
  }
  const results: number[][] = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    try {
      const extractor = await getPipeline();
      const output = await extractor(batch, { pooling: "mean", normalize: true });
      const vectors = output.tolist();
      results.push(...vectors);
    } catch (err) {
      console.error("[embed] batch embedding failed:", err);
      // エラー時は空ベクトルで埋める
      for (let j = 0; j < batch.length; j++) {
        results.push([]);
      }
    }
  }
  return results;
}

export { EMBED_DIM };
