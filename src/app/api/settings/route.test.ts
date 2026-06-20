// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { EMBED_MODEL_BASE, getEmbedModelOptions } from "@/app/api/settings/route";

describe("EMBED_MODEL_OPTIONS", () => {
  it("各項目が model/dim/provider/labelKey を持つ", () => {
    for (const opt of EMBED_MODEL_BASE) {
      expect(typeof opt.model).toBe("string");
      expect(typeof opt.dim).toBe("number");
      expect(opt.provider === "local" || opt.provider === "http").toBe(true);
      expect(typeof opt.labelKey).toBe("string");
    }
  });

  it("getEmbedModelOptions が翻訳された label を持つ", () => {
    const opts = getEmbedModelOptions("ja");
    for (const opt of opts) {
      expect(typeof opt.label).toBe("string");
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it("LFM2.5-Embedding-350M が http プロバイダ・1024 次元で含まれる", () => {
    const lfm = EMBED_MODEL_BASE.find(
      (o) => o.model === "LiquidAI/LFM2.5-Embedding-350M",
    );
    expect(lfm).toBeDefined();
    expect(lfm!.provider).toBe("http");
    expect(lfm!.dim).toBe(1024);
  });

  it("既存 Xenova モデルは全て local プロバイダ", () => {
    const xenova = EMBED_MODEL_BASE.filter((o) => o.model.startsWith("Xenova/"));
    expect(xenova.length).toBeGreaterThan(0);
    for (const opt of xenova) {
      expect(opt.provider).toBe("local");
    }
  });
});

/**
 * getVectorDim の空テーブル検出検証。
 *
 * memories テーブルが空でも、列の宣言型 vector(N) から次元を取得できること。
 * これにより初回モデル切替時（行がまだない状態）でもマイグレーションが
 * 提示される。vector_dims() は行がないと NULL を返すため、format_type への
 * フォールバックが必須。
 */
describe("memories vector column dimension detection", () => {
  const testContentHash = "dimdetection-test-hash";

  beforeAll(async () => {
    // テスト用の残存行を確実に除去
    await db.execute(sql`DELETE FROM memories WHERE content_hash = ${testContentHash}`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM memories WHERE content_hash = ${testContentHash}`);
  });

  it("行が存在する場合は vector_dims() で次元を取得", async () => {
    // 現在の列次元を取得（宣言型）
    const colResult = await db.execute(sql`
      SELECT format_type(atttypid, atttypmod) as ty
      FROM pg_attribute
      WHERE attrelid = 'memories'::regclass AND attname = 'embedding'
    `);
    const colRows = (colResult as { rows?: Array<{ ty: string }> }).rows ?? [];
    const declared = colRows[0]?.ty?.match(/vector\((\d+)\)/)?.[1];
    expect(declared).toBeDefined();
    const declaredDim = Number(declared);

    // テスト用のゼロベクトルを挿入（thread_id は既存スレッドを借用）
    const zeroVec = "[" + new Array(declaredDim).fill(0).join(",") + "]";
    await db.execute(sql`DELETE FROM memories WHERE content_hash = ${testContentHash}`);
    await db.execute(sql`
      INSERT INTO memories (thread_id, kind, content, content_hash, model, embedding)
      SELECT t.id, 'fact', 'dim detection test', ${testContentHash}, 'test-model', ${zeroVec}::vector
      FROM threads t LIMIT 1
    `);

    // 行が存在するので vector_dims() で取得できる
    const result = await db.execute(sql`SELECT vector_dims(embedding) as dim FROM memories WHERE content_hash = ${testContentHash}`);
    const rows = (result as { rows?: Array<{ dim: number }> }).rows ?? [];
    expect(rows.length).toBe(1);
    expect(rows[0].dim).toBe(declaredDim);

    // クリーンアップ: 行を削除して空に戻す
    await db.execute(sql`DELETE FROM memories WHERE content_hash = ${testContentHash}`);
  });

  it("行が空でも列の宣言型 vector(N) から次元を取得できる", async () => {
    // テスト用ハッシュの行が存在しないことを保証（テーブル全体が空でなくても
    // 列の宣言型は取得できる）
    const colResult = await db.execute(sql`
      SELECT format_type(atttypid, atttypmod) as ty
      FROM pg_attribute
      WHERE attrelid = 'memories'::regclass AND attname = 'embedding'
    `);
    const colRows = (colResult as { rows?: Array<{ ty: string }> }).rows ?? [];
    expect(colRows.length).toBe(1);
    const m = colRows[0].ty.match(/vector\((\d+)\)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
  });
});
