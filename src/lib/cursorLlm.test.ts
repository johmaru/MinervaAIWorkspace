// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildCursorPrompt, extractStreamDeltas } from "@/lib/cursorLlm";
import type { SDKMessage } from "@cursor/sdk";

describe("cursorLlm helpers", () => {
  it("buildCursorPrompt includes system, history, and user", () => {
    const prompt = buildCursorPrompt({
      systemContent: "Be concise.",
      history: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
      userContent: "What next?",
    });
    expect(prompt).toContain("System instructions:");
    expect(prompt).toContain("Be concise.");
    expect(prompt).toContain("User:\nHi");
    expect(prompt).toContain("Assistant:\nHello");
    expect(prompt).toContain("User:\nWhat next?");
  });

  it("extractStreamDeltas emits assistant text deltas", () => {
    const deltas: string[] = [];
    const thinking: string[] = [];
    const state = { assistantText: "", thinkingText: "" };

    const first: SDKMessage = {
      type: "assistant",
      agent_id: "a",
      run_id: "r",
      message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
    };
    extractStreamDeltas(first, state, {
      onDelta: (d) => deltas.push(d),
      onReasoning: (d) => thinking.push(d),
    });
    expect(deltas).toEqual(["Hel"]);

    const second: SDKMessage = {
      type: "assistant",
      agent_id: "a",
      run_id: "r",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    };
    extractStreamDeltas(second, state, {
      onDelta: (d) => deltas.push(d),
      onReasoning: (d) => thinking.push(d),
    });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(state.assistantText).toBe("Hello");
  });

  it("extractStreamDeltas emits thinking deltas", () => {
    const thinking: string[] = [];
    const state = { assistantText: "", thinkingText: "" };
    const ev: SDKMessage = {
      type: "thinking",
      agent_id: "a",
      run_id: "r",
      text: "plan…",
    };
    extractStreamDeltas(ev, state, {
      onDelta: () => {},
      onReasoning: (d) => thinking.push(d),
    });
    expect(thinking).toEqual(["plan…"]);
  });
});
