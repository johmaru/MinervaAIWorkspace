import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCombobox } from "@/components/ModelCombobox";

afterEach(() => {
  cleanup();
});

describe("ModelCombobox", () => {
  it("renders the current value and accepts freeform input", () => {
    const onChange = vi.fn();
    render(
      <ModelCombobox
        value="umans-glm-5.2"
        onChange={onChange}
        models={["umans-glm-5.2", "gpt-4o"]}
        aria-label="Model"
      />,
    );
    const input = screen.getByRole("combobox", { name: "Model" });
    expect(input).toHaveValue("umans-glm-5.2");
    fireEvent.change(input, { target: { value: "gpt-4.1" } });
    expect(onChange).toHaveBeenCalledWith("gpt-4.1");
  });

  it("exposes datalist suggestions for known models", () => {
    const { container } = render(
      <ModelCombobox
        value=""
        onChange={() => {}}
        models={["a", "b"]}
        displayNames={{ a: "Model A" }}
        aria-label="Model"
      />,
    );
    const options = container.querySelectorAll("datalist option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("value", "a");
    expect(options[0]).toHaveAttribute("label", "Model A");
  });

  it("includes an empty option when allowEmpty is set", () => {
    const { container } = render(
      <ModelCombobox
        value=""
        onChange={() => {}}
        models={["m1"]}
        allowEmpty
        emptyLabel="disabled"
        aria-label="Fallback"
      />,
    );
    const options = container.querySelectorAll("datalist option");
    expect(options[0]).toHaveAttribute("value", "");
    expect(options[0]).toHaveAttribute("label", "disabled");
  });
});
