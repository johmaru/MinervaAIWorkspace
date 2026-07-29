import { h } from "hastscript";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";
import type { Plugin } from "unified";

const CONTAINER_NAMES = new Set(["callout", "richlist"]);
const TEXT_NAMES = new Set(["mark"]);

export const remarkRichBlocks: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, (node) => {
      if (
        node.type !== "containerDirective" &&
        node.type !== "leafDirective" &&
        node.type !== "textDirective"
      ) {
        return;
      }
      const name = node.name;
      if (!name) return;
      const data = node.data || (node.data = {});
      const attributes = node.attributes || {};

      if (node.type === "textDirective") {
        if (!TEXT_NAMES.has(name)) return;
        const hast = h("span", attributes);
        data.hName = "span";
        data.hProperties = hast.properties;
      } else if (CONTAINER_NAMES.has(name)) {
        const hast = h(name, attributes);
        data.hName = hast.tagName;
        data.hProperties = hast.properties;
      }
      // Unknown directives: left untouched → render as plain text / default.
    });
  };
};
