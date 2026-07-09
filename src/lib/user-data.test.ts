// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { getUserDataRoot, getDataDir } from "./user-data";

describe("user-data", () => {
  const origExecPath = process.execPath;
  const origCwd = process.cwd();

  afterEach(() => {
    delete process.env.UMANS_USER_ROOT;
    process.execPath = origExecPath;
    vi.restoreAllMocks();
  });

  it("getUserDataRoot returns UMANS_USER_ROOT when set", () => {
    vi.stubEnv("UMANS_USER_ROOT", "/custom/user/root");
    expect(getUserDataRoot()).toBe("/custom/user/root");
  });

  it("getUserDataRoot returns null when UMANS_USER_ROOT unset", () => {
    delete process.env.UMANS_USER_ROOT;
    expect(getUserDataRoot()).toBeNull();
  });

  it("getDataDir returns join(root, data) when UMANS_USER_ROOT set", () => {
    vi.stubEnv("UMANS_USER_ROOT", "/custom/user/root");
    expect(getDataDir()).toBe(join("/custom/user/root", "data"));
  });

  it("getDataDir falls back to dirname(execPath)/data for compiled exe", () => {
    delete process.env.UMANS_USER_ROOT;
    process.execPath = "/app/umanschat.exe";
    expect(getDataDir()).toBe(join("/app", "data"));
  });

  it("getDataDir falls back to cwd/data for non-compiled (dev)", () => {
    delete process.env.UMANS_USER_ROOT;
    process.execPath = "/usr/local/bin/node";
    expect(getDataDir()).toBe(join(process.cwd(), "data"));
  });
});
