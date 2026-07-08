// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { redirectMock, signInMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(),
  signInMock: vi.fn(),
}));

// Mock next/navigation redirect — it throws a NEXT_REDIRECT error internally.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirectMock(url);
    throw new Error("NEXT_REDIRECT");
  },
}));

// Mock @/auth signIn — avoids real Auth.js session creation.
vi.mock("@/auth", () => ({
  signIn: signInMock,
  signOut: vi.fn(),
}));

import { db } from "@/db";
import { users, threads, folders } from "@/db/schema";
import { eq } from "drizzle-orm";
import { register } from "@/app/actions/auth";

const createdUserIds: string[] = [];
const createdThreadIds: string[] = [];
const createdFolderIds: string[] = [];

afterAll(async () => {
  for (const id of createdThreadIds) {
    await db.delete(threads).where(eq(threads.id, id));
  }
  for (const id of createdFolderIds) {
    await db.delete(folders).where(eq(folders.id, id));
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

function formData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("nickname", "testuser");
  fd.set("email", "test-register@example.com");
  fd.set("password", "password123");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

describe("register", () => {
  it("creates a user with valid input (sync transaction)", async () => {
    const email = `sync-tx-${Date.now()}@example.com`;
    await expect(register(undefined, formData({ email }))).rejects.toThrow("NEXT_REDIRECT");

    // register calls signIn + redirect on success, which throws NEXT_REDIRECT
    expect(redirectMock).toHaveBeenCalledWith("/");

    // Verify the user was actually inserted
    const [row] = await db
      .select({ id: users.id, email: users.email, nickname: users.nickname })
      .from(users)
      .where(eq(users.email, email));
    expect(row).toBeDefined();
    expect(row!.email).toBe(email);
    expect(row!.nickname).toBe("testuser");
    createdUserIds.push(row!.id);
  });

  it("returns error for short password", async () => {
    const result = await register(undefined, formData({ password: "short" }));
    expect(result).toEqual({ error: "auth.passwordTooShort" });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("returns error for invalid email", async () => {
    const result = await register(undefined, formData({ email: "notanemail" }));
    expect(result).toEqual({ error: "auth.emailInvalid" });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("returns error for missing nickname", async () => {
    const result = await register(undefined, formData({ nickname: "" }));
    expect(result).toEqual({ error: "auth.nicknameRequired" });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("returns error for duplicate email", async () => {
    const email = `dup-${Date.now()}@example.com`;
    // First registration succeeds (throws NEXT_REDIRECT via redirect)
    await expect(register(undefined, formData({ email }))).rejects.toThrow("NEXT_REDIRECT");
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (row) createdUserIds.push(row.id);

    // Clear mock calls from the first registration before testing the duplicate
    vi.clearAllMocks();

    // Second registration with same email should fail
    const result = await register(undefined, formData({ email }));
    expect(result).toEqual({ error: "auth.emailTaken" });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
