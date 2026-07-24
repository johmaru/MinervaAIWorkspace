import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as I18nTypes from "@/lib/i18n/types";

vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<I18nTypes>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});

const fetchMock = vi.fn();
vi.mock("@/lib/clientFetch", () => ({
  clientFetch: (...args: unknown[]) => fetchMock(...args),
}));

import { SkillManagerModal } from "@/components/SkillManagerModal";
import { I18nProvider } from "@/components/I18nProvider";

function renderModal() {
  render(
    <I18nProvider>
      <SkillManagerModal open={true} onClose={() => {}} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  // Default: all fetches return empty arrays
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => [],
  });
});

afterEach(() => cleanup());

describe("SkillManagerModal — evolution tab", () => {
  it("renders 4 tabs including evolution", async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getByText("既存スキル改善")).toBeDefined();
    });
    // All 4 tabs should render
    expect(screen.getByText("アクティブ")).toBeDefined();
    expect(screen.getByText("下書き候補")).toBeDefined();
    expect(screen.getByText("アーカイブ")).toBeDefined();
  });

  it("shows evolution empty message when no proposals", async () => {
    renderModal();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Click evolution tab
    const evoTab = screen.getByText("既存スキル改善");
    evoTab.click();
    await waitFor(() => {
      expect(screen.getByText("改善提案はありません")).toBeDefined();
    });
  });

  it("renders evolution proposal when present", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("skill-evolution-proposals")) {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            id: "prop-1",
            skillId: "skill-1",
            skillName: "Docker rebuild",
            baseVersion: 1,
            previousContent: "Old content",
            proposedContent: "New content",
            proposedName: null,
            proposedTrigger: null,
            proposedTags: null,
            patchSummary: "Added a step",
            reason: "User found it unhelpful",
            evidenceEventIds: [],
            contentHash: "hash123",
            status: "draft",
            appliedVersion: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    renderModal();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Click evolution tab
    screen.getByText("既存スキル改善").click();
    await waitFor(() => {
      expect(screen.getByText("Docker rebuild")).toBeDefined();
      expect(screen.getByText("変更概要: Added a step")).toBeDefined();
    });
  });

  it("renders lifetime counts on active skill cards", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/skills") {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            id: "skill-1",
            name: "Test Skill",
            content: "content",
            kind: "workflow",
            trigger: null,
            tags: [],
            status: "active",
            version: 1,
            lastUsedAt: null,
            successCount: 5,
            failureCount: 2,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    renderModal();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByText("成功 5 / 失敗 2")).toBeDefined();
    });
  });
});
