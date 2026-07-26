// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  extractSubjectHints,
  mergeAndRerankKbHits,
  prefixChunkWithTitle,
  scoreKbHit,
  titleSpeaker,
  type RankableKbHit,
} from "./kbSearchRank";

describe("kbSearchRank", () => {
  it("extracts subject 愛 from Japanese question", () => {
    const hints = extractSubjectHints("試しに愛が過去にはまってるって言ってた物は何？");
    expect(hints).toContain("愛");
  });

  it("titleSpeaker reads name before pipe", () => {
    expect(titleSpeaker("小美山愛 | メッセージ | 戦術")).toBe("小美山愛");
  });

  it("boosts matching speaker over higher raw similarity wrong speaker", () => {
    const query = "愛が過去にはまってるって言ってた物は何？";
    const subjects = extractSubjectHints(query);
    const saki: RankableKbHit = {
      chunkId: "1",
      documentId: "d1",
      kbId: "k",
      title: "白石沙季 | メッセージ | アイドルが好きなんです！②",
      text: "白石沙季: 最近は、マイペースでかたじけない、っていうアイドルにハマッています",
      similarity: 0.72,
    };
    const ai: RankableKbHit = {
      chunkId: "2",
      documentId: "d2",
      kbId: "k",
      title: "小美山愛 | ホーム会話 | 自己紹介",
      text: "小美山愛: アイドルの趣味が筋トレって可愛くはない気がしていて…",
      similarity: 0.48,
    };
    expect(scoreKbHit(ai, query, subjects)).toBeGreaterThan(scoreKbHit(saki, query, subjects));

    const ranked = mergeAndRerankKbHits([saki, ai], [], query, 2);
    expect(ranked[0]!.title).toMatch(/小美山愛/);
  });

  it("keyword path can surface speaker when vector only returns wrong character", () => {
    const query = "愛がはまってる物";
    const saki: RankableKbHit = {
      chunkId: "1",
      documentId: "d1",
      kbId: "k",
      title: "白石沙季 | メッセージ | x",
      text: "ハマッています",
      similarity: 0.7,
    };
    const aiKw: RankableKbHit = {
      chunkId: "2",
      documentId: "d2",
      kbId: "k",
      title: "小美山愛 | メッセージ | 筋トレ",
      text: "小美山愛: 筋トレメニューも",
      similarity: 0.5,
    };
    const ranked = mergeAndRerankKbHits([saki], [aiKw], query, 2);
    expect(ranked[0]!.title).toMatch(/小美山愛/);
  });

  it("prefixChunkWithTitle adds speaker when missing", () => {
    expect(prefixChunkWithTitle("小美山愛 | メッセージ | x", "続きのセリフ")).toContain("小美山愛");
    expect(prefixChunkWithTitle("小美山愛 | メッセージ | x", "小美山愛: はい")).toBe("小美山愛: はい");
  });
});
