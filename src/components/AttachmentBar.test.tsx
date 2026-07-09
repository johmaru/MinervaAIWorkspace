import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/types")>();
  return { ...actual, DEFAULT_LOCALE: "ja" as const };
});
import { AttachmentBar } from "@/components/AttachmentBar";
import { I18nProvider } from "@/components/I18nProvider";
import type { MessageAttachment } from "@/hooks/useChat";

beforeEach(() => {
  localStorage.setItem("umanschat-locale", "ja");
});

afterEach(() => {
  cleanup();
});

function makeAttachment(overrides?: Partial<MessageAttachment>): MessageAttachment {
  return {
    id: "att-1",
    messageId: null,
    filename: "test.png",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    ...overrides,
  };
}

function renderBar(props: { attachments: MessageAttachment[]; onRemove?: (id: string) => void }) {
  return render(
    <I18nProvider>
      <AttachmentBar attachments={props.attachments} onRemove={props.onRemove} />
    </I18nProvider>,
  );
}

describe("AttachmentBar — display", () => {
  it("renders nothing when there are no attachments", () => {
    const { container } = renderBar({ attachments: [] });
    expect(container.firstChild).toBeNull();
  });

  it("renders image attachments as thumbnails", () => {
    renderBar({ attachments: [makeAttachment()] });
    const img = screen.getByAltText("test.png");
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
  });

  it("renders text attachments with a file icon", () => {
    renderBar({
      attachments: [makeAttachment({ filename: "doc.pdf", mimeType: "application/pdf", dataUrl: null })],
    });
    expect(screen.getByText("doc.pdf")).toBeInTheDocument();
  });

  it("displays the filename", () => {
    renderBar({ attachments: [makeAttachment({ filename: "photo.jpg" })] });
    expect(screen.getByText("photo.jpg")).toBeInTheDocument();
  });

  it("renders multiple attachments", () => {
    renderBar({
      attachments: [
        makeAttachment({ id: "a1", filename: "img1.png" }),
        makeAttachment({ id: "a2", filename: "img2.png" }),
      ],
    });
    expect(screen.getByText("img1.png")).toBeInTheDocument();
    expect(screen.getByText("img2.png")).toBeInTheDocument();
  });
});

describe("AttachmentBar — remove", () => {
  it("shows a remove button when onRemove is provided", () => {
    const onRemove = vi.fn();
    renderBar({ attachments: [makeAttachment()], onRemove });
    const btn = screen.getByLabelText("test.png を削除");
    expect(btn).toBeInTheDocument();
  });

  it("does not show a remove button when onRemove is absent", () => {
    renderBar({ attachments: [makeAttachment()] });
    expect(screen.queryByLabelText("test.png を削除")).not.toBeInTheDocument();
  });

  it("calls onRemove when the remove button is clicked", () => {
    const onRemove = vi.fn();
    renderBar({ attachments: [makeAttachment({ id: "att-x" })], onRemove });
    fireEvent.click(screen.getByLabelText("test.png を削除"));
    expect(onRemove).toHaveBeenCalledWith("att-x");
  });
});
