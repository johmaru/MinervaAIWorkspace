// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildJsonlFilterFromToolArgs,
  jsonlLineMatches,
  parseKeyValuePairs,
} from "./jsonlFilter";

describe("jsonlFilter", () => {
  it("matches equals / contains / anyFieldContains", () => {
    const row = {
      character_id: "char-ai",
      name: "小美山愛",
      title: "小美山愛 | メッセージ | x",
      kind: "message",
      content: "hello",
    };
    expect(jsonlLineMatches(row, { equals: { character_id: "char-ai" } })).toBe(true);
    expect(jsonlLineMatches(row, { equals: { character_id: "char-aoi" } })).toBe(false);
    expect(jsonlLineMatches(row, { contains: { name: "愛" } })).toBe(true);
    expect(jsonlLineMatches(row, { contains: { name: "沙季" } })).toBe(false);
    expect(
      jsonlLineMatches(row, {
        anyFieldContains: { fields: ["name", "title"], value: "メッセージ" },
      }),
    ).toBe(true);
    expect(
      jsonlLineMatches(row, {
        equals: { kind: "message" },
        contains: { name: "愛" },
      }),
    ).toBe(true);
  });

  it("parses k=v pairs and tool filter args", () => {
    expect(parseKeyValuePairs("character_id=char-ai,kind=message")).toEqual({
      character_id: "char-ai",
      kind: "message",
    });
    const f = buildJsonlFilterFromToolArgs({
      filter_contains: "name=愛",
      filter_any_fields: "name,title",
      filter_any_value: "愛",
    });
    expect(f?.contains?.name).toBe("愛");
    expect(f?.anyFieldContains?.fields).toEqual(["name", "title"]);
    expect(jsonlLineMatches({ name: "小美山愛", title: "x" }, f)).toBe(true);
    expect(jsonlLineMatches({ name: "白石沙季", title: "x" }, f)).toBe(false);
  });

  it("merges filter_json", () => {
    const f = buildJsonlFilterFromToolArgs({
      filter_json: JSON.stringify({ equals: { kind: "profile" } }),
      filter_contains: "name=愛",
    });
    expect(f?.equals?.kind).toBe("profile");
    expect(f?.contains?.name).toBe("愛");
  });
});
