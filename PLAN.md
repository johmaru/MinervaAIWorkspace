# Qdrant統合 + ruri-v3-310m移行 計画

## 目標

- KB検索バックエンドを環境変数で切替可能にする（デフォルトQdrant、フォールバックsqlite-vec）
- ruri-v3-310m（768次元）をデフォルトembeddingモデルにする
- 既存のsqlite-vecデータをQdrantに移行できるようにする
- 他のユーザーもQdrantコンテナを立てれば使える汎用構成にする
- ipr-rag（my_obsidian_agent側）はruri-v3で再embed済みなので触らない

## 確認済みの前提

| 項目 | 値 |
|---|---|
| ruri-v3-310m次元数 | 768 |
| ruri-v3プレフィックス | `検索クエリ:` / `検索文書:` をテキスト先頭に付与（非prompt_name） |
| Qdrant ipr-ragコレクション | 70,743件・768次元・ruri-v3で再embed済み |
| UmansChat現状 | LFM2.5（1024次元）・EMBED_PROVIDER=http |
| embedder/main.pyの問題点 | LFM2.5専用のpoolingハック（mean pooling強制）とprompt_name方式がハードコード |
| Qdrant接続先 | localhost:6335（my_obsidian_agentのdocker-compose） |

## Phase 1: embedder の汎用化

### 問題

`embedder/main.py` にはLFM2.5専用のハードコードがある:

1. **poolingハック**（39-45行）: LFM2.5のCLSトークンが定数ベクトルを返す問題を回避するため、mean poolingを強制設定。ruri-v3には不要だが、存在しても害はない（ruri-v3は元々mean pooling）。
2. **prompt_name方式**（97-98行）: `kind="query"` → `prompt_name="query"` でLFM2.5の `query:` / `document:` プレフィックスを適用。ruri-v3は `prompt_name` ではなくテキストプレフィックス `検索クエリ:` / `検索文書:` を使う。このままではruri-v3でプレフィックスが付かず、検索品質が劣化する。

### 改修内容

`embedder/main.py` にモデル別のprefix設定を追加:

```python
# モデル別prefix設定
MODEL_PREFIXES = {
    "ruri-v3": {"query": "検索クエリ: ", "document": "検索文書: "},
    "lfm2.5": {"query": None, "document": None},  # prompt_nameで処理
    "default": {"query": None, "document": None},
}

def get_prefix_config(model_id: str) -> dict:
    model_lower = model_id.lower()
    if "ruri" in model_lower:
        return MODEL_PREFIXES["ruri-v3"]
    elif "lfm" in model_lower:
        return MODEL_PREFIXES["lfm2.5"]
    return MODEL_PREFIXES["default"]
```

`/embed` エンドポイントで、prefix_configが `None` でなければテキストプレフィックスを付与し、`prompt_name` は使わない:

```python
@app.post("/embed")
def embed(req: EmbedRequest) -> EmbedResponse:
    transformer = _model["transformer"]
    prefix_config = get_prefix_config(EMBEDDER_MODEL)

    texts = req.texts
    if req.kind and prefix_config.get(req.kind):
        prefix = prefix_config[req.kind]
        texts = [f"{prefix}{t}" for t in texts]

    encode_kwargs = {}
    # prompt_nameはLFM2.5等のprompt_name対応モデルのみ使用
    if req.kind and prefix_config.get(req.kind) is None and "lfm" in EMBEDDER_MODEL.lower():
        encode_kwargs["prompt_name"] = req.kind

    vectors = transformer.encode(texts, normalize_embeddings=True, **encode_kwargs)
    return EmbedResponse(vectors=vectors.tolist())
```

poolingハックはモデル判定して条件適用:

```python
# LFM2.5のみCLS poolingを無効化（ruri-v3には不要だが無害）
if "lfm" in EMBEDDER_MODEL.lower():
    pooling = transformer[1]
    pooling.pooling_mode_cls_token = False
    pooling.pooling_mode_mean_tokens = True
```

### スタートアップ自己テストの更新

既存のプローブテストはそのまま（2つの異なる文字列が異なるベクトルを返すことを確認）。ruri-v3でも有効。

### 検証

```bash
# ruri-v3でプレフィックスが効いているか確認
curl -X POST http://localhost:8001/embed \
  -H "Content-Type: application/json" \
  -d '{"texts":["テスト"], "kind":"query"}'
# → "検索クエリ: テスト" としてembedされる
```

## Phase 2: Qdrant接続設定

### 環境変数

`.env` / `docker-compose.yml` に追加:

```env
# Vector search backend: qdrant | sqlite-vec
VECTOR_BACKEND=sqlite-vec
# Qdrant接続（VECTOR_BACKEND=qdrant時）
QDRANT_URL=http://localhost:6335
QDRANT_API_KEY=
```

デフォルトは `sqlite-vec`（後方互換性）。Qdrantを使いたいユーザーが明示的に `VECTOR_BACKEND=qdrant` を設定する。

### docker-compose.yml

Qdrantサービスをオプション追加:

```yaml
  qdrant:
    image: qdrant/qdrant:latest
    container_name: umanschat-qdrant
    ports:
      - "6333:6333"
    volumes:
      - umanschat-qdrant:/qdrant/storage
    restart: unless-stopped
    profiles: ["qdrant"]  # docker compose --profile qdrant up で有効化

volumes:
  umanschat-qdrant:
```

`profiles` を使うことで、Qdrantを使わないユーザーはコンテナが立ち上がらない。

## Phase 3: 検索インターフェースの抽象化

### VectorBackend インターフェース

`src/lib/vectorBackend.ts` を新規作成:

```typescript
export interface VectorSearchHit {
  id: string;
  text: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

export interface VectorBackend {
  search(queryVector: number[], options: {
    collection: string;
    userId: string;
    kbIds?: string[];
    limit: number;
    threshold: number;
  }): Promise<VectorSearchHit[]>;

  /** Store chunk vectors. SqliteVecBackend → db.insert(kbChunks), QdrantBackend → HTTP upsert. */
  upsert(chunks: ChunkUpsert[], options: {
    userId: string;
    kbId: string;
  }): Promise<void>;
}

export interface ChunkUpsert {
  id: string;
  text: string;
  embedding: number[];
  ordinal: number;
  documentId: string;
  documentTitle: string;
  sourceType: string;
}
```

### sqlite-vec実装（既存コードのラッパー）

`src/lib/vectorBackendSqlite.ts` — 現在の `searchKnowledgeBases()` のSQL部分を抽出:

```typescript
export class SqliteVecBackend implements VectorBackend {
  async search(queryVector: number[], options: SearchOptions): Promise<VectorSearchHit[]> {
    const queryBuf = toVecBuffer(queryVector);
    const rows = await db.all(sql`
      SELECT kc.id, kc.text, kc.document_id,
             vec_distance_cosine(kc.embedding, ${queryBuf}) AS distance
      FROM kb_chunks kc
      INNER JOIN kb_documents d ON kc.document_id = d.id
      INNER JOIN knowledge_bases kb ON kc.knowledge_base_id = kb.id
      WHERE kb.user_id = ${options.userId}
        AND kc.knowledge_base_id IN (${kbIdList})
        AND vec_distance_cosine(kc.embedding, ${queryBuf}) < ${1 - options.threshold}
      ORDER BY distance
      LIMIT ${options.limit}
    `);
    return rows.map(rowToHit);
  }
}
```

### Qdrant実装

`src/lib/vectorBackendQdrant.ts` を新規作成:

```typescript
export class QdrantBackend implements VectorBackend {
  private url: string;
  private apiKey?: string;

  constructor() {
    this.url = process.env.QDRANT_URL || "http://localhost:6333";
    this.apiKey = process.env.QDRANT_API_KEY || undefined;
  }

  async search(queryVector: number[], options: SearchOptions): Promise<VectorSearchHit[]> {
    const body: Record<string, unknown> = {
      vector: queryVector,
      limit: options.limit,
      with_payload: true,
      score_threshold: options.threshold,
    };

    // userId でフィルタ（マルチユーザー分離）
    if (options.userId) {
      body.filter = {
        must: [{ key: "user_id", match: { value: options.userId } }]
      };
    }
    if (options.kbIds && options.kbIds.length > 0) {
      body.filter = {
        must: [
          ...(body.filter?.must ?? []),
          { key: "kb_id", match: { any: options.kbIds } }
        ]
      };
    }

    const res = await fetch(`${this.url}/collections/${options.collection}/points/search`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Qdrant search failed: ${res.status}`);

    const data = await res.json();
    return data.result.map((hit: QdrantHit) => ({
      id: hit.id,
      text: hit.payload.text,
      similarity: hit.score,
      metadata: hit.payload,
    }));
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["api-key"] = this.apiKey;
    return h;
  }
}
```

### バックエンド選択ファクトリ

`src/lib/vectorBackend.ts` にファクトリ関数:

```typescript
let backend: VectorBackend | null = null;

export function getVectorBackend(): VectorBackend {
  if (!backend) {
    const backendType = process.env.VECTOR_BACKEND || "sqlite-vec";
    backend = backendType === "qdrant"
      ? new QdrantBackend()
      : new SqliteVecBackend();
  }
  return backend;
}
```

### searchKnowledgeBases の改修

`kbStore.ts` の `searchKnowledgeBases()` で、ベクトル検索部分を `getVectorBackend().search()` に委譲。キーワード検索（LIKE）はsqlite-vecのまま（Qdrantのpayload filterでも代替可能だが、キーワード検索は後回し）。
## Phase 4: Qdrantへのデータ格納

### コレクション構成

UmansChatのKBデータは1コレクションに集約:

```
コレクション名: umanschat_kb
  vector size: 768 (EMBED_DIM)
  distance: Cosine
  payload:
    - user_id (string, index)
    - kb_id (string, index)
    - document_id (string)
    - text (string)
### ingestDocument の改修

kb_chunksへの格納を `getVectorBackend().upsert()` に統一。
`instanceof` で分岐せず、インターフェースメソッドで抽象化:

```typescript
// kbStore.ts ingestDocument 内
// SqliteVecBackend.upsert → db.insert(kbChunks).values(chunkRows)
// QdrantBackend.upsert → POST /collections/umanschat_kb/points (batch upsert)
await getVectorBackend().upsert(
  chunkRows.map(c => ({
    id: c.id, text: c.text, embedding: c.embedding,
    ordinal: c.ordinal, documentId: doc.id,
    documentTitle: source.title, sourceType: source.sourceType,
  })),
  { userId, kbId },
);
```

kbStore.ts は QdrantBackend を直接 import しない。
バックエンドの切替は `VECTOR_BACKEND` 環境変数のみで完結する。

kb_documents と knowledge_bases テーブルはSQLiteに残す（メタデータ管理）。
ベクトルとチャンクテキストのみQdrantに格納。

### 他の検索パスの扱い

`vec_distance_cosine` 呼び出し元は計7箇所あるが、VectorBackend抽象化の対象は
`kb_chunks`（KB検索）のみ。理由: 他のテーブルは件数が少なく、sqlite-vecでも
実用範囲内（memories 80ms、page_embeddings 190ms、skills/todosは1桁件数）。

| テーブル | 件数 | 検索パス | VectorBackend化 |
|---|---:|---|---|
| `kb_chunks` | 3,377+ | `kbStore.ts` searchKnowledgeBases | **対象** |
| `memories` | 239 | `memoryStore.ts`, `search/route.ts`, `memory.ts` | そのまま |
| `page_embeddings` | 665 | `search/route.ts` | そのまま |
| `skills` | 8 | `skillStore.ts`, `skillCandidate.ts` | そのまま |
| `user_traits` | α | `memory.ts` | そのまま |
| `todos` | α | `todoStore.ts` | そのまま |

## Phase 5: sqlite-vec → Qdrant 移行スクリプト

`scripts/migrate-to-qdrant.ts` を新規作成:

```typescript
// 1. Qdrantコレクション作成
//    PUT /collections/umanschat_kb { vectors: { size: EMBED_DIM, distance: "Cosine" } }

// 2. kb_chunksを全件取得
//    SELECT * FROM kb_chunks kc
//    JOIN kb_documents d ON kc.document_id = d.id
//    JOIN knowledge_bases kb ON kc.knowledge_base_id = kb.id

// 3. EMBED_MODELが変更されている場合は再embed
//    if (existingModel !== EMBEDDER_MODEL) {
//      vectors = await embedTexts(chunks.map(c => c.text), "document");
//    } else {
//      vectors = chunks.map(c => c.embedding);  // そのまま転送
//    }

// 4. バッチでQdrantにupsert
//    POST /collections/umanschat_kb/points
//    { points: [{ id, vector, payload }] }
//    100件ずつ
```

LFM2.5（1024次元）→ ruri-v3（768次元）の移行なので、**全件再embedが必須**。
768次元のベクトルをQdrantに格納。

## Phase 6: ruri-v3-310m 設定

### .env の変更

```env
EMBED_MODEL=cl-nagoya/ruri-v3-310m
EMBED_DIM=768
EMBEDDER_MODEL=cl-nagoya/ruri-v3-310m
```

### マイグレーショントリガーの修正

`settings/route.ts:318` の `needsMigration` は次元変更のみを検知する:
```typescript
const needsMigration = body.embedDim !== undefined && body.embedDim !== dbVectorDim;
```

これには2つのバグがある:

1. **削除欠落**: コメント335行に「memories and page_embeddings ... are deleted」と書いてあるが、
   対応する `db.delete()` が存在しない。skills と todos の再embedしか行われない。
   memories(239件)・page_embeddings(665件)・user_traits が古い次元のベクトルのまま残り、
   新次元クエリとの `vec_distance_cosine` が壊れる。

2. **モデル名変更の未検知**: 同じ次元の別モデルに切り替えた場合
   （例: 1024次元のモデルA → 1024次元のモデルB）、`needsMigration` が発火せず、
   古いベクトル空間のベクトルがそのまま残る。cosine検索が無言で壊れる。
   「汎用的な対応」の要件上、他のユーザーがこの罠に落ちるのを防ぐ必要がある。

Phase 6 で以下を修正する:

1. `needsMigration` のトリガーにモデル名変更を追加:
   ```typescript
   const modelChanged = body.embedModel !== undefined && body.embedModel !== currentEmbedModel;
   const needsMigration = (body.embedDim !== undefined && body.embedDim !== dbVectorDim) || modelChanged;
   ```
2. マイグレーション実行時に memories・page_embeddings・user_traits の embedding を再embed
   （content カラムから再生成可能）:
   - memories: `SELECT id, content FROM memories WHERE embedding IS NOT NULL`
   - page_embeddings: `SELECT pe.id, p.content FROM page_embeddings pe JOIN pages p ON pe.page_id = p.id`
   - user_traits: `SELECT id, content FROM user_traits WHERE embedding IS NOT NULL`
3. 既存の skills/todos 再embedはそのまま
4. `EMBEDDER_MODEL=cl-nagoya/ruri-v3-310m` でembedderコンテナ再起動
5. 移行スクリプト実行（Phase 5）でkb_chunksをQdrantに移行
6. `VECTOR_BACKEND=qdrant` に切り替え

memories は会話から再生成可能だが、再embedの方がデータを失わない。
page_embeddings は pages テーブルの content から再embed可能。
user_traits は content カラムから再embed可能。

## ファイル変更一覧

| ファイル | 変更内容 |
|---|---|
| `embedder/main.py` | モデル別prefix設定、poolingハックの条件化 |
| `src/lib/vectorBackend.ts` | 新規: VectorBackend インターフェース + ファクトリ |
| `src/lib/vectorBackendSqlite.ts` | 新規: sqlite-vec実装（既存SQL抽出） |
| `src/lib/vectorBackendQdrant.ts` | 新規: Qdrant実装 |
| `src/lib/kbStore.ts` | searchKnowledgeBases を VectorBackend 経由に変更 |
| `src/lib/kbStore.ts` | ingestDocument を VectorBackend 切替対応 |
| `src/app/api/chat/route.ts` | 変更不要（buildKnowledgeContextMessage経由で透過） |
| `.env.example` | VECTOR_BACKEND, QDRANT_URL, QDRANT_API_KEY 追加 |
| `docker-compose.yml` | qdrantサービス追加（profiles指定） |
| `scripts/migrate-to-qdrant.ts` | 新規: 移行スクリプト |
| `src/lib/vectorBackendQdrant.test.ts` | 新規: Qdrant バックエンドのテスト |
| `README.md` / `README.ja.md` | Qdrant設定手順の追加 |

## 実行順序

1. **Phase 1**: embedder/main.py の汎用化 → テスト
2. **Phase 2-3**: 環境変数 + VectorBackend インターフェース + Qdrant実装
3. **Phase 4**: ingestDocument の切替対応
4. **Phase 5**: 移行スクリプト
5. **Phase 6**: ruri-v3 設定 + 実データ移行
6. typecheck + test
7. README更新

## リスク

1. **ruri-v3プレフィックスの非対称性**: クエリ時は `検索クエリ:`、ドキュメント時は `検索文書:` を付与。embedder側で `kind` パラメータ経由で自動付与するが、呼び出し側が `kind` を正しく渡しているか確認が必要。
2. **Qdrantコレクションのuser_id分離**: マルチユーザー環境でpayload filter `user_id` で分離。Qdrantのpayload indexを作成しないとフィルタが遅くなる。
3. **既存ipr-rag MCPツール**: my_obsidian_agent側の `ipr-rag-mcp.py` は既にruri-v3で動いているので影響なし。UmansChatからipr-ragを検索したい場合は別途MCPサーバーとして登録する。
4. **sqlite-vecフォールバック**: `VECTOR_BACKEND=sqlite-vec` に戻す場合、Qdrantに移行したデータはSQLite側にないので検索結果が空になる。フォールバックは新規データのみ。
