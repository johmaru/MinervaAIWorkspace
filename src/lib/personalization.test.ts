// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildPersonalizationMessage,
  PERSONAL_STYLES,
} from "@/lib/personalization";

describe("buildPersonalizationMessage", () => {
  it("style が null の場合は null を返す", () => {
    expect(buildPersonalizationMessage(null, 1, 1, 1, 1)).toBeNull();
  });

  it("style が無効な文字列の場合は null を返す", () => {
    expect(buildPersonalizationMessage("unknown", 1, 1, 1, 1)).toBeNull();
    expect(buildPersonalizationMessage("", 1, 1, 1, 1)).toBeNull();
  });

  it("有効な style の場合は非 null 文字列を返す", () => {
    for (const style of PERSONAL_STYLES) {
      const msg = buildPersonalizationMessage(style, 1, 1, 1, 1);
      expect(msg).not.toBeNull();
      expect(typeof msg).toBe("string");
      expect(msg!.length).toBeGreaterThan(0);
    }
  });

  it("スタイル説明文を含む", () => {
    const msg = buildPersonalizationMessage("polite", 1, 1, 1, 1);
    expect(msg).toContain("丁寧な敬語");
  });

  it("4つのトレイト指示を全て含む", () => {
    const msg = buildPersonalizationMessage("standard", 1, 1, 1, 1);
    expect(msg).toContain("温かみ");
    expect(msg).toContain("熱量");
    expect(msg).toContain("見出しとリスト");
    expect(msg).toContain("絵文字");
  });

  it("優先指示を含む", () => {
    const msg = buildPersonalizationMessage("standard", 1, 1, 1, 1);
    expect(msg).toContain("優先して適用");
  });

  it("スライダーレベル 0/1/2 で異なるトレイト文を生成する", () => {
    const level0 = buildPersonalizationMessage("standard", 0, 0, 0, 0)!;
    const level1 = buildPersonalizationMessage("standard", 1, 1, 1, 1)!;
    const level2 = buildPersonalizationMessage("standard", 2, 2, 2, 2)!;

    // 温かみ
    expect(level0).toContain("事実ベースで感情を含めず");
    expect(level1).toContain("標準的な温かみ");
    expect(level2).toContain("親身で共感的な温かみ");

    // 絵文字
    expect(level0).toContain("絵文字を使用しない");
    expect(level1).toContain("少量の絵文字");
    expect(level2).toContain("絵文字を積極的に");

    // 3レベル全てが異なる文字列
    expect(level0).not.toBe(level1);
    expect(level1).not.toBe(level2);
    expect(level0).not.toBe(level2);
  });

  it("範囲外のスライダー値はクランプされる", () => {
    const below = buildPersonalizationMessage("standard", -5, -5, -5, -5)!;
    const at0 = buildPersonalizationMessage("standard", 0, 0, 0, 0)!;
    expect(below).toBe(at0);

    const above = buildPersonalizationMessage("standard", 99, 99, 99, 99)!;
    const at2 = buildPersonalizationMessage("standard", 2, 2, 2, 2)!;
    expect(above).toBe(at2);
  });
});
