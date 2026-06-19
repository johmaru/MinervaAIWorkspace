// @vitest-environment node
import { describe, expect, it } from "vitest";
import { t, getRequestLocale } from "@/lib/i18n";
import { ja, en } from "@/lib/i18n/dictionaries";
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, SUPPORTED_LOCALES } from "@/lib/i18n/types";

describe("t() — 翻訳取得", () => {
  it("ja 辞書から common.save を取得", () => {
    expect(t("ja", "common.save")).toBe("保存");
  });

  it("en 辞書から common.save を取得", () => {
    expect(t("en", "common.save")).toBe("Save");
  });

  it("ja で補間文字列 chat.referenceCount を置換", () => {
    expect(t("ja", "chat.referenceCount", { count: 3 })).toBe("📚 参照元: 3件");
  });

  it("en で補間文字列 chat.referenceCount を置換", () => {
    expect(t("en", "chat.referenceCount", { count: 3 })).toBe("📚 References: 3");
  });

  it("存在しないキーは key をそのまま返す（フォールバック）", () => {
    expect(t("ja", "nonexistent.key")).toBe("nonexistent.key");
  });

  it("ネストした存在しないキーもフォールバック", () => {
    expect(t("en", "common.nonexistent")).toBe("common.nonexistent");
  });

  it("複数プレースホルダを置換", () => {
    expect(t("ja", "chat.branchPosition", { current: 1, total: 3 })).toBe("枝 1 / 3");
  });

  it("未対応ロケールは DEFAULT_LOCALE にフォールバック", () => {
    expect(t("fr" as never, "common.save")).toBe(t(DEFAULT_LOCALE, "common.save"));
  });
});

describe("getRequestLocale() — Cookie 検出", () => {
  it("Cookie umanschat-locale=en から en を検出", () => {
    const req = new Request("http://localhost/api/test", {
      headers: { cookie: `${LOCALE_COOKIE_NAME}=en` },
    });
    expect(getRequestLocale(req)).toBe("en");
  });

  it("Cookie なし時に DEFAULT_LOCALE を返す", () => {
    const req = new Request("http://localhost/api/test");
    expect(getRequestLocale(req)).toBe(DEFAULT_LOCALE);
  });

  it("不正値 umanschat-locale=fr を DEFAULT_LOCALE にフォールバック", () => {
    const req = new Request("http://localhost/api/test", {
      headers: { cookie: `${LOCALE_COOKIE_NAME}=fr` },
    });
    expect(getRequestLocale(req)).toBe(DEFAULT_LOCALE);
  });

  it("他の Cookie が混在していても正しく検出", () => {
    const req = new Request("http://localhost/api/test", {
      headers: { cookie: `theme=dark; ${LOCALE_COOKIE_NAME}=en; foo=bar` },
    });
    expect(getRequestLocale(req)).toBe("en");
  });
});

describe("辞書キー構造の一貫性", () => {
  /**
   * ja と en が全く同じキー構造を持つことを実行時に検証。
   * 型レベル（en: typeof ja）でも担保されるが、実行時テストで二重確認。
   */
  function collectKeys(obj: unknown, prefix: string = ""): string[] {
    if (typeof obj !== "object" || obj === null) return [];
    const keys: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "object" && v !== null) {
        keys.push(...collectKeys(v, fullKey));
      } else {
        keys.push(fullKey);
      }
    }
    return keys;
  }

  it("ja と en が同じキーセットを持つ", () => {
    const jaKeys = collectKeys(ja).sort();
    const enKeys = collectKeys(en).sort();
    expect(enKeys).toEqual(jaKeys);
  });

  it("SUPPORTED_LOCALES に ja と en が含まれる", () => {
    expect(SUPPORTED_LOCALES).toContain("ja");
    expect(SUPPORTED_LOCALES).toContain("en");
  });
});
