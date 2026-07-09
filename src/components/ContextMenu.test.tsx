import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type MenuItem } from "@/components/ContextMenu";

afterEach(() => {
  cleanup();
});

const items: MenuItem[] = [
  { type: "item", label: "設定", onClick: vi.fn() },
  { type: "separator" },
  { type: "item", label: "削除", onClick: vi.fn(), danger: true },
  { type: "item", label: "無効項目", onClick: vi.fn(), disabled: true },
];

describe("ContextMenu", () => {
  it("calls onClick + onClose on item click", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);

    fireEvent.click(screen.getByText("設定"));
    expect(items[0].type === "item" && items[0].onClick).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("delete item has danger class", () => {
    render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />);
    const delBtn = screen.getByText("削除");
    expect(delBtn.className).toContain("text-red-500");
  });

  it("renders separator", () => {
    render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />);
    // separator is a div with h-px bg-border (inside the portal body)
    const separators = document.body.querySelectorAll(".h-px.bg-border");
    expect(separators).toHaveLength(1);
  });

  it("disabled item has disabled attribute", () => {
    render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />);
    const disabledBtn = screen.getByText("無効項目");
    expect(disabledBtn).toBeDisabled();
  });

  it("does not call onClick when disabled item is clicked", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
    fireEvent.click(screen.getByText("無効項目"));
    // disabled button click does not fire (browser default behavior)
    const disabledItem = items[3];
    if (disabledItem.type === "item") {
      expect(disabledItem.onClick).not.toHaveBeenCalled();
    }
  });

  it("closes on Esc key", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on click-outside", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
    // mousedown outside the menu
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not call onClose on click inside the menu (before item click)", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    fireEvent.mouseDown(menu);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sets role=menu and role=menuitem", () => {
    render(<ContextMenu x={10} y={10} items={items} onClose={vi.fn()} />);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3); // excluding separator
  });
});
