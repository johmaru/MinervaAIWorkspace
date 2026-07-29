// @vitest-environment node
import { describe, expect, it } from "vitest";
import { remark } from "remark";
import remarkDirective from "remark-directive";
import { remarkRichBlocks } from "./remarkRichBlocks";

async function run(md: string) {
  const processor = remark().use(remarkDirective).use(remarkRichBlocks);
  const tree = processor.parse(md);
  const file = await processor.run(tree);
  return file;
}

function findDirective(tree: any): any {
  let found: any = null;
  function walk(node: any) {
    if (node.type === "containerDirective" || node.type === "textDirective") found = node;
    if (node.children) for (const c of node.children) walk(c);
  }
  walk(tree);
  return found;
}

describe("remarkRichBlocks", () => {
  it("maps callout containerDirective to hName=callout with type", async () => {
    const tree = await run(":::callout{type=\"warning\"}\nbody\n:::") as any;
    const node = findDirective(tree);
    expect(node.data.hName).toBe("callout");
    expect(node.data.hProperties.type).toBe("warning");
  });

  it("maps richlist containerDirective to hName=richlist with marker", async () => {
    const tree = await run(":::richlist{marker=\"check\"}\n- a\n:::") as any;
    const node = findDirective(tree);
    expect(node.data.hName).toBe("richlist");
    expect(node.data.hProperties.marker).toBe("check");
  });

  it("maps mark textDirective to hName=span with class", async () => {
    const tree = await run(":mark[hi]{.big}") as any;
    const node = findDirective(tree);
    expect(node.data.hName).toBe("span");
    expect(node.data.hProperties.className).toEqual(["big"]);
  });

  it("leaves unknown directives untouched", async () => {
    const tree = await run(":::unknown{x=1}\nbody\n:::") as any;
    const node = findDirective(tree);
    expect(node.data?.hName).toBeUndefined();
  });
});
