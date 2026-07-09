// @vitest-environment node
import { describe, expect, it } from "vitest";
import { t, getRequestLocale } from "@/lib/i18n";
import { ja, en } from "@/lib/i18n/dictionaries";
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, SUPPORTED_LOCALES } from "@/lib/i18n/types";

describe("t() — translation retrieval", () => {
  it("retrieves common.save from the ja dictionary", () => {
    expect(t("ja", "common.save")).toBe("保存");
  });

  it("retrieves common.save from the en dictionary", () => {
    expect(t("en", "common.save")).toBe("Save");
  });

  it("replaces interpolation string chat.referenceCount in ja", () => {
    expect(t("ja", "chat.referenceCount", { count: 3 })).toBe("📚 参照元: 3件");
  });

  it("replaces interpolation string chat.referenceCount in en", () => {
    expect(t("en", "chat.referenceCount", { count: 3 })).toBe("📚 References: 3");
  });

  it("returns the key as-is for nonexistent keys (fallback)", () => {
    expect(t("ja", "nonexistent.key")).toBe("nonexistent.key");
  });

  it("falls back for nested nonexistent keys", () => {
    expect(t("en", "common.nonexistent")).toBe("common.nonexistent");
  });

  it("replaces multiple placeholders", () => {
    expect(t("ja", "chat.branchPosition", { current: 1, total: 3 })).toBe("枝 1 / 3");
  });

  it("falls back to DEFAULT_LOCALE for unsupported locales", () => {
    expect(t("fr" as never, "common.save")).toBe(t(DEFAULT_LOCALE, "common.save"));
  });
});

describe("getRequestLocale() — cookie detection", () => {
  it("detects en from cookie umanschat-locale=en", () => {
    const req = new Request("http://localhost/api/test", {
      headers: { cookie: `${LOCALE_COOKIE_NAME}=en` },
    });
    expect(getRequestLocale(req)).toBe("en");
  });

  it("returns DEFAULT_LOCALE when no cookie is present", () => {
    const req = new Request("http://localhost/api/test");
    expect(getRequestLocale(req)).toBe(DEFAULT_LOCALE);
  });

  it("falls back to DEFAULT_LOCALE for invalid value umanschat-locale=fr", () => {
    const req = new Request("http://localhost/api/test", {
      headers: { cookie: `${LOCALE_COOKIE_NAME}=fr` },
    });
    expect(getRequestLocale(req)).toBe(DEFAULT_LOCALE);
  });

  it("correctly detects when other cookies are mixed in", () => {
    const req = new Request("http://localhost/api/test", {
      headers: { cookie: `theme=dark; ${LOCALE_COOKIE_NAME}=en; foo=bar` },
    });
    expect(getRequestLocale(req)).toBe("en");
  });
});

describe("dictionary key structure consistency", () => {
  /**
   * Verifies at runtime that ja and en have exactly the same key structure.
   * Also guaranteed at the type level (en: typeof ja), but double-checked via runtime test.
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

  it("ja and en have the same key set", () => {
    const jaKeys = collectKeys(ja).sort();
    const enKeys = collectKeys(en).sort();
    expect(enKeys).toEqual(jaKeys);
  });

  it("SUPPORTED_LOCALES includes ja and en", () => {
    expect(SUPPORTED_LOCALES).toContain("ja");
    expect(SUPPORTED_LOCALES).toContain("en");
  });
});
