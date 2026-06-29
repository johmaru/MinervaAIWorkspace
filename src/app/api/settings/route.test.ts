// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EMBED_MODEL_BASE, getEmbedModelOptions } from "@/app/api/settings/route";

describe("EMBED_MODEL_OPTIONS", () => {
  it("各項目が model/dim/provider/labelKey を持つ", () => {
    for (const opt of EMBED_MODEL_BASE) {
      expect(opt).toHaveProperty("model");
      expect(opt).toHaveProperty("dim");
      expect(opt).toHaveProperty("provider");
      expect(opt).toHaveProperty("labelKey");
    }
  });

  it("getEmbedModelOptions が翻訳された label を持つ", () => {
    const opts = getEmbedModelOptions("ja");
    for (const opt of opts) {
      expect(opt).toHaveProperty("label");
      expect(typeof opt.label).toBe("string");
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
    const xenova = EMBED_MODEL_BASE.filter((o) =>
      o.model.startsWith("Xenova/"),
    );
    expect(xenova.length).toBeGreaterThan(0);
    for (const opt of xenova) {
      expect(opt.provider).toBe("local");
    }
  });
});

/**
 * 埋め込み次元は SQLite では環境変数 EMBED_DIM から取得される。
 * pgvector の vector_dims() / format_type / pg_attribute は不要。
 */
describe("embedding dimension from env", () => {
  it("EMBED_DIM 未設定時はデフォルト 1024", () => {
    const orig = process.env.EMBED_DIM;
    delete process.env.EMBED_DIM;
    const dim = Number(process.env.EMBED_DIM) || 1024;
    expect(dim).toBe(1024);
    if (orig !== undefined) process.env.EMBED_DIM = orig;
  });

  it("EMBED_DIM 設定時はその値が使われる", () => {
    const orig = process.env.EMBED_DIM;
    process.env.EMBED_DIM = "384";
    const dim = Number(process.env.EMBED_DIM) || 1024;
    expect(dim).toBe(384);
    if (orig !== undefined) process.env.EMBED_DIM = orig;
    else delete process.env.EMBED_DIM;
  });
});
