// @vitest-environment node
import { describe, it, expect } from "vitest";
import { PRESET_META, sandboxFail } from "./types";

describe("PRESET_META", () => {
  it("code_run is implemented at tier 1", () => {
    expect(PRESET_META.code_run).toEqual({
      securityTier: 1,
      timeoutSec: 30,
      implemented: true,
    });
  });

  it("file_inspect is not implemented", () => {
    expect(PRESET_META.file_inspect.implemented).toBe(false);
    expect(PRESET_META.file_inspect.securityTier).toBe(2);
  });

  it("malware_analysis is not implemented", () => {
    expect(PRESET_META.malware_analysis.implemented).toBe(false);
    expect(PRESET_META.malware_analysis.securityTier).toBe(3);
  });
});

describe("sandboxFail", () => {
  it("builds a failure result with code and message", () => {
    const result = sandboxFail("docker_unavailable", "docker daemon not reachable");
    expect(result).toEqual({
      ok: false,
      error: { code: "docker_unavailable", message: "docker daemon not reachable" },
    });
  });

  it("does not carry success fields", () => {
    const result = sandboxFail("timeout", "exceeded 30s");
    expect(result.ok).toBe(false);
    expect("stdout" in result).toBe(false);
    expect("exitCode" in result).toBe(false);
  });
});
