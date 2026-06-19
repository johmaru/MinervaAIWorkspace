import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentBar } from "@/components/AttachmentBar";
import { I18nProvider } from "@/components/I18nProvider";
import type { MessageAttachment } from "@/hooks/useChat";

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

describe("AttachmentBar — 表示", () => {
  it("添付ファイルなしの場合は何も表示しない", () => {
    const { container } = renderBar({ attachments: [] });
    expect(container.firstChild).toBeNull();
  });

  it("画像添付ファイルはサムネイル表示", () => {
    renderBar({ attachments: [makeAttachment()] });
    const img = screen.getByAltText("test.png");
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
  });

  it("テキスト添付ファイルはファイルアイコン表示", () => {
    renderBar({
      attachments: [makeAttachment({ filename: "doc.pdf", mimeType: "application/pdf", dataUrl: null })],
    });
    expect(screen.getByText("doc.pdf")).toBeInTheDocument();
  });

  it("ファイル名が表示される", () => {
    renderBar({ attachments: [makeAttachment({ filename: "photo.jpg" })] });
    expect(screen.getByText("photo.jpg")).toBeInTheDocument();
  });

  it("複数添付ファイルを表示", () => {
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

describe("AttachmentBar — 削除", () => {
  it("onRemove がある場合は削除ボタンを表示", () => {
    const onRemove = vi.fn();
    renderBar({ attachments: [makeAttachment()], onRemove });
    const btn = screen.getByLabelText("test.png を削除");
    expect(btn).toBeInTheDocument();
  });

  it("onRemove がない場合は削除ボタンを表示しない", () => {
    renderBar({ attachments: [makeAttachment()] });
    expect(screen.queryByLabelText("test.png を削除")).not.toBeInTheDocument();
  });

  it("削除ボタン押下で onRemove を呼ぶ", () => {
    const onRemove = vi.fn();
    renderBar({ attachments: [makeAttachment({ id: "att-x" })], onRemove });
    fireEvent.click(screen.getByLabelText("test.png を削除"));
    expect(onRemove).toHaveBeenCalledWith("att-x");
  });
});
