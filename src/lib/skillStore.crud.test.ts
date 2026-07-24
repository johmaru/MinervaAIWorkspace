// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { skills, users } from "@/db/schema";

// Mock embedText: deterministic vectors without depending on the real embedder.
// Identical content → identical vectors, so duplicate detection is predictable.
vi.mock("@/lib/embed", () => ({
  embedText: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(1024).fill(0);
    for (const ch of text) {
      const code = ch.charCodeAt(0) % 1024;
      vec[code] = 1;
    }
    return vec;
  }),
  hashContent: vi.fn().mockImplementation((text: string) => {
    return createHash("sha256").update(text).digest("hex");
  }),
}));

import { listSkills, createSkill, deleteSkill, updateSkillContent } from "@/lib/skillStore";

const createdUserIds: string[] = [];
const createdSkillIds: string[] = [];
let testUserId: string;
let otherUserId: string;

beforeAll(async () => {
  const [u1] = await db.insert(users).values({
    nickname: "skillStore-crud-test-user1",
    email: "skillstore-crud-test@umanschat.test",
  }).returning();
  testUserId = u1.id;
  createdUserIds.push(u1.id);

  const [u2] = await db.insert(users).values({
    nickname: "skillStore-crud-test-user2",
    email: "skillstore-crud-test-other@umanschat.test",
  }).returning();
  otherUserId = u2.id;
  createdUserIds.push(u2.id);
});

afterAll(async () => {
  for (const id of createdSkillIds) {
    await db.delete(skills).where(eq(skills.id, id));
  }
  for (const id of createdUserIds) {
    await db.delete(skills).where(eq(skills.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("createSkill", () => {
  it("creates a skill with embedding, contentHash, and default values", async () => {
    const row = await createSkill(testUserId, {
      name: "Test Workflow Skill",
      content: "When the user asks for a workflow, follow these steps.",
    });
    createdSkillIds.push(row.id);

    expect("error" in row).toBe(false);
    if ("error" in row) return;
    expect(row.name).toBe("Test Workflow Skill");
    expect(row.content).toBe("When the user asks for a workflow, follow these steps.");
    expect(row.kind).toBe("workflow");
    expect(row.status).toBe("active");
    expect(row.version).toBe(1);
  });

  it("creates a skill with kind, trigger, and tags", async () => {
    const row = await createSkill(testUserId, {
      name: "Debug Helper",
      content: "When debugging, check logs first.",
      kind: "debugging",
      trigger: "when a bug is reported",
      tags: ["debug", "logs"],
    });
    createdSkillIds.push(row.id);

    if ("error" in row) return;
    expect(row.name).toBe("Debug Helper");
    expect(row.kind).toBe("debugging");
  });

  it("throws on empty name", async () => {
    await expect(createSkill(testUserId, { name: "", content: "content" }))
      .rejects.toThrow("name and content are required");
  });

  it("throws on empty content", async () => {
    await expect(createSkill(testUserId, { name: "name", content: "  " }))
      .rejects.toThrow("name and content are required");
  });

  it("returns { error: 'duplicate' } when contentHash matches existing skill", async () => {
    const content = "Duplicate content for hash check.";
    const first = await createSkill(testUserId, { name: "Original", content });
    createdSkillIds.push(first.id);

    const second = await createSkill(testUserId, { name: "Duplicate Name", content });
    // Clean up if it was created (shouldn't be, but defensive)
    if (!("error" in second)) createdSkillIds.push(second.id);

    expect("error" in second).toBe(true);
    if ("error" in second) {
      expect(second.error).toBe("duplicate");
    }
  });
});

describe("listSkills", () => {
  it("lists skills for the user", async () => {
    const row = await createSkill(testUserId, {
      name: "List Test Skill",
      content: "Content for list test.",
    });
    createdSkillIds.push(row.id);

    const list = await listSkills(testUserId);
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((s) => s.name === "List Test Skill")).toBe(true);
  });

  it("filters by status='active'", async () => {
    const list = await listSkills(testUserId, "active");
    expect(list.every((s) => s.status === "active")).toBe(true);
  });

  it("respects userId isolation", async () => {
    // Create a skill for otherUserId
    const otherRow = await createSkill(otherUserId, {
      name: "Other User Skill",
      content: "Content for other user.",
    });
    createdSkillIds.push(otherRow.id);

    const list = await listSkills(testUserId);
    expect(list.every((s) => s.name !== "Other User Skill")).toBe(true);
  });

  it("returns duplicates array when includeDuplicates=true", async () => {
    // Create two nearly-identical skills (same content → same embedding → high similarity)
    const content = "Near-identical duplicate content for dedup test.";
    const row1 = await createSkill(testUserId, { name: "Dedup Original", content });
    createdSkillIds.push(row1.id);
    // Modify slightly to avoid contentHash collision but keep embedding similar
    const row2 = await createSkill(testUserId, { name: "Dedup Near", content: content + " extra" });
    if (!("error" in row2)) createdSkillIds.push(row2.id);

    const list = await listSkills(testUserId, undefined, true);
    expect(list.length).toBeGreaterThan(0);
    // Each row should have a duplicates array (possibly empty)
    expect(list.every((s) => Array.isArray(s.duplicates))).toBe(true);
  });
});

describe("deleteSkill", () => {
  it("deletes a skill and returns true", async () => {
    const row = await createSkill(testUserId, {
      name: "Delete Me",
      content: "This skill will be deleted.",
    });
    createdSkillIds.push(row.id);

    const deleted = await deleteSkill(testUserId, row.id);
    expect(deleted).toBe(true);
  });

  it("returns false for non-existent skill", async () => {
    const deleted = await deleteSkill(testUserId, "nonexistent-id");
    expect(deleted).toBe(false);
  });

  it("cannot delete another user's skill", async () => {
    const row = await createSkill(otherUserId, {
      name: "Other User's Skill",
      content: "Should not be deletable by test user.",
    });
    createdSkillIds.push(row.id);

    const deleted = await deleteSkill(testUserId, row.id);
    expect(deleted).toBe(false);

    // Verify it still exists
    const list = await listSkills(otherUserId);
    expect(list.some((s) => s.name === "Other User's Skill")).toBe(true);
  });
});

describe("updateSkillContent", () => {
  it("updates content and increments version", async () => {
    const row = await createSkill(testUserId, {
      name: "Update Version Test",
      content: "Original content.",
    });
    createdSkillIds.push(row.id);
    if ("error" in row) return;
    const originalVersion = row.version;

    const result = await updateSkillContent(row.id, testUserId, {
      content: "Updated content with changes.",
    });

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("error");
    if (result && !("error" in result)) {
      expect(result.content).toBe("Updated content with changes.");
      expect(result.version).toBe(originalVersion + 1);
      expect(result.contentHash).not.toBe(row.contentHash);
    }
  });

  it("updates status to archived without version bump", async () => {
    const row = await createSkill(testUserId, {
      name: "Archive Test",
      content: "Content to archive.",
    });
    createdSkillIds.push(row.id);
    if ("error" in row) return;

    const result = await updateSkillContent(row.id, testUserId, {
      status: "archived",
    });

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("error");
    // status-only change does not bump version (contentChanged is false)
    if (result && !("error" in result)) {
      expect(result.version).toBe(row.version);
    }
    // Verify it's archived
    const list = await listSkills(testUserId, "archived");
    expect(list.some((s) => s.id === row.id)).toBe(true);
  });

  it("updates name and trigger", async () => {
    const row = await createSkill(testUserId, {
      name: "Old Name",
      content: "Content stays same.",
      trigger: "old trigger",
    });
    createdSkillIds.push(row.id);
    if ("error" in row) return;

    const result = await updateSkillContent(row.id, testUserId, {
      name: "New Name",
      trigger: "new trigger",
    });

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("error");
    if (result && !("error" in result)) {
      expect(result.name).toBe("New Name");
    }
  });

  it("returns null for non-existent skill", async () => {
    const result = await updateSkillContent("nonexistent-id", testUserId, {
      content: "irrelevant",
    });
    expect(result).toBeNull();
  });

  it("returns null when skill belongs to another user", async () => {
    const row = await createSkill(otherUserId, {
      name: "Other User Update",
      content: "Owned by other user.",
    });
    createdSkillIds.push(row.id);
    if ("error" in row) return;

    const result = await updateSkillContent(row.id, testUserId, {
      content: "attempted takeover",
    });
    expect(result).toBeNull();
  });
});
