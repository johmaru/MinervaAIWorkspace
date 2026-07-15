# モデルフォールバック（TTFTベース）設計

## 概要

ストリーミングチャットパスにフォールバック機構を追加する。プライマリモデルが設定可能なタイムアウト以内に最初のトークン（content/reasoning delta）を出力しない場合、進行中のストリームを中断し、フォールバックモデルで再試行する。

## 背景

UmansChatのメインチャットパスは**ストリーミング**（`streamCompletion` → `llm.chat.completions.create({ stream: true })`）である。トークンは到着順にSSE `delta` / `thinking` イベントでクライアントに送信される。現在フォールバックは存在せず、プライマリモデルが遅いか無応答の場合、OpenAIクライアントの120秒タイムアウトまでユーザーが待機することになる。

`createLLM()` は `timeout: 120_000` と `maxRetries: 1` を設定しているが、`streamCompletion` 内で `AbortSignal` は使われていない。OpenAI SDKの組み込みタイムアウトはリクエスト全体の死滅をカバーするが、「最初のトークンが遅い」ケースはカバーしない — モデルは何も送信せずにコネクションを開いたまま保持できる。

## トリガー: TTFT（Time-to-First-Token）

フォールバックは **deltaが1つも到着しない** 場合にのみ発火する。最初のdeltaが到着した時点でタイムアウトはキャンセルされ、そのモデルで最後までストリーミングされる。つまり:

- **部分出力の衝突なし**: クライアントはまだ何もコンテンツを受信していないため、モデル切替がクリーンに行える — `replace_content` は不要。
- **フォールバックは1回限り**: フォールバック先モデルでもTTFTタイムアウトが発生した場合、通常のエラーとして伝播される（3つ目のモデルへの連鎖はしない）。

## 環境変数

| 変数 | 説明 | デフォルト |
|---|---|---|
| `LLM_FALLBACK_MODEL` | フォールバック先モデルid。未設定ならフォールバック無効。 | _(未設定 = 無効)_ |
| `LLM_FALLBACK_TIMEOUT_MS` | 最初のトークンを待つミリ秒数。 | `10000`（10秒） |

## 対象コード

### `src/lib/llm.ts` — 新規ヘルパー関数

```ts
export function fallbackModel(): string | null {
  const v = process.env.LLM_FALLBACK_MODEL;
  return v?.trim() || null;
}

export function fallbackTimeoutMs(): number {
  const v = Number(process.env.LLM_FALLBACK_TIMEOUT_MS);
  return v > 0 ? v : 10_000;
}
```

### `src/app/api/chat/route.ts` — `streamCompletion` の変更

**シグネチャ**: `onModelFallback?: (model: string) => void` をパラメータに追加。

```ts
async function streamCompletion({
  ...既存パラメータ,
  onModelFallback,
}: {
  ...既存の型,
  onModelFallback?: (model: string) => void;
}) {
```

**TTFTタイムアウトロジック**（`while (true)` ループ内、`llm.chat.completions.create` 呼び出しをラップ）:

```
model_to_use = model  // プライマリモデルで開始
fallback = fallbackModel()
timeout_ms = fallbackTimeoutMs()

if fallback is null → タイムアウトロジックを完全にスキップ（現行の挙動）

for each round in the tool-use loop:
  AbortController を生成 (abortCtl)
  タイマー開始: setTimeout(() => abortCtl.abort(), timeout_ms)

  completion = llm.chat.completions.create({
    model: model_to_use,
    ...,
    stream: true,
  }, { signal: abortCtl.signal })   // ← フォールバック設定時のみsignalを渡す

  first_delta_received = false

  for await (chunk of completion):
    if not first_delta_received:
      // 最初のcontent/reasoning deltaがタイムアウトをキャンセル
      if chunk has content or reasoning delta:
        first_delta_received = true
        clearTimeout(timer)

    ...通常のチャンク処理 (onDelta, onReasoning, tool_calls)...

  // タイムアウトせずにループ完了 → 通常フロー、breakまたはtool round継続
  // abort発火（AbortError）かつdelta未受信かつフォールバック設定済みの場合:
  //   → model_to_use = fallback に切替
  //   → 再試行時はツール使用を無効化 (useToolsThisRound = false)
  //   → onModelFallback(fallback) を呼び出し、呼び出し元が finalModel を更新
  //   → "status" イベント送信（フォールバック通知）
  //   → このラウンドを再実行（roundsをインクリメントせずにwhileループをcontinue）
  //   → 新しい llm.chat.completions.create は model_to_use（=fallback）を使用
  //   → 新しいタイムアウトは設定しない（フォールバックは1回限り）
```

**主要不変条件**:
- タイムアウトは1回のみ発火（最初のラウンド、最初の試行）。フォールバック後は2回目のタイムアウトなし。
- `onModelFallback` は厳密に1回（または0回）呼び出される。
- 最初のdelta到着後のtool-callラウンドではフォールバックは発火しない（タイムアウトは既にキャンセル済み）。
- `LLM_FALLBACK_MODEL` が未設定の場合、コードパスは現行と完全に同一（signalなし、タイマーなし）。

### ツール使用モードとの相互作用

ツール使用モード（`useTools === true`）では、最初のラウンドがcontentではなくtool_callsを返す場合がある。TTFTウィンドウ内にtool_callsが生成された場合、それは「最初のトークン受信」とみなす（tool_call deltaがタイムアウトをキャンセル）。タイムアウトは **いかなるチャンクも到着しない** 場合 — content、reasoning、tool_callsいずれも — にのみ発火する。

**フォールバック再試行時はツール使用を無効化する。** フォールバック時、元の `useTools` 設定に関わらず `useToolsThisRound = false` で再試行する。

**設計判断とトレードオフ**: フォールバック先モデルがツール使用をサポートするかどうかは不明 — `probeToolSupport` はプライマリモデルに対してのみ実行されているため、フォールバック先モデルの能力は分からない。2つの選択肢を検討した:

1. **フォールバック時はツール使用を無効化（採用）**: 再試行はプレーンなcompletionリクエスト（`tools` なし、`tool_choice` なし）を送信する。フォールバック先モデルは訓練データ＋既に注入済みの事前検索コンテキストから直接回答する。安全・シンプル・追加レイテンシなし。

2. **フォールバック先モデルのツールサポートを再プローブ**: 再試行前に `probeToolSupport(llm, fallbackModel)` を実行し、サポートされていればツールを使用。フォールバック先モデルでの検索/スクレイプ機能を維持できるが、プローブのレイテンシ（さらなるLLMラウンドトリップ）が追加される — フォールバックの目的と逆行する。プローブ自体も遅い可能性がある。

選択肢1を採用する。理由: フォールバックは緊急パスであり、ツール使用能力を維持するよりも *何らかの* 応答を素早く得ることの方が価値が高い。ユーザーがツール使用を必要とする場合は、スレッドのモデルを明示的に切替えればよい。

### `src/app/api/chat/route.ts` — 呼び出し元の更新

各 `streamCompletion` 呼び出し箇所で `onModelFallback` コールバックを渡し、`finalModel` を更新する:

```ts
await streamCompletion({
  ...,
  onModelFallback: (m) => { finalModel = m; },
});
```

これにより `done` イベントとDB `metadata.model` が実際に使用されたモデルを反映する。**6箇所**の呼び出し箇所がある（行 ~353, ~376, ~405, ~426, ~464, ~511）。

### `src/lib/i18n/dictionaries.ts` — 新規ステータスメッセージ

```ts
// JA
statusModelFallback: "応答が遅いため、フォールバックモデル（{model}）に切り替えました。",

// EN
statusModelFallback: "Response was slow, switching to fallback model ({model}).",
```

フォールバック再試行前に `status` SSEイベントを送信し、クライアントに視覚的な切替を表示する。

## クライアント側への影響

**なし。** クライアントは既に `status` イベントを処理し（一時ラベルとして表示）、`done` イベントから `model` を読み取る。`useChat.ts` の変更は不要。

## 対象外

- `completeText`（非ストリーミング、hyper/dual/councilで使用）— 対象外。これらのフローは複数のLLM呼び出しを行い、独自のエラーハンドリングを持つ。
- フォールバックの連鎖（3つ目以降のモデル）— 1回限り。
- ストリーム途中（最初のトークン到着後）のエラーによるフォールバック — 対応しない。TTFTのみがフォールバックのトリガー。

## テスト

### ユニットテスト（`src/lib/llm.test.ts`）
- `fallbackModel()` は環境変数設定時にその値を返す。未設定時に `null` を返す。
- `fallbackTimeoutMs()` は有効な環境変数値を返す。未設定/無効時に `10000` を返す。

### 統合テスト（`src/app/api/chat/route.test.ts`）
- **フォールバック発火**: `llm.chat.completions.create` をモックし、最初のトークンをタイムアウト超えて遅延させる → フォールバックモデルの `status` イベント、`done` イベントのmodelがフォールバックモデルであることを検証。
- **フォールバック非発火**: タイムアウト内に最初のトークンが到着 → フォールバックstatusなし、`done` がプライマリモデルであることを検証。
- **フォールバック無効**: `LLM_FALLBACK_MODEL` 未設定 → タイムアウト挙動なし（signal未渡し）を検証。
