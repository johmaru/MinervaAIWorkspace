const CALLOUT_START_RE = /^:::callout\{([^}]*)\}/;
const RICHLIST_RE = /:::richlist\{([^}]*)\}\n([\s\S]*?)\n:::/g;
const MARK_RE = /:mark\[([^\]]*)\]\{\.([a-z]+)\}/g;

const CALLOUT_TYPES = new Set(["note", "tip", "warning", "danger"]);

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function convertCallouts(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const start = CALLOUT_START_RE.exec(line);
    if (!start) {
      out.push(line);
      i++;
      continue;
    }

    const attrsRaw = start[1];
    i++;
    const bodyLines: string[] = [];
    let depth = 1;
    while (i < lines.length && depth > 0) {
      const current = lines[i];
      if (current === ":::") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
        bodyLines.push(current);
      } else if (CALLOUT_START_RE.test(current)) {
        depth++;
        bodyLines.push(current);
      } else {
        bodyLines.push(current);
      }
      i++;
    }

    const a = parseAttrs(attrsRaw);
    const type = CALLOUT_TYPES.has(a.type) ? a.type : "note";
    const header = a.title ? `> [!${type}] ${a.title}` : `> [!${type}]`;
    const nestedBody = convertRichBlocksForExport(bodyLines.join("\n"));
    const bodyOut = nestedBody
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => (l.startsWith("> ") ? l : `> ${l}`.trimEnd()));
    out.push([header, ...bodyOut].join("\n"));
  }
  return out.join("\n");
}

export function convertRichBlocksForExport(content: string): string {
  let out = content;

  // callout → Obsidian native: > [!type] Title\n> bodyline
  out = convertCallouts(out);

  // richlist → plain list (strip the wrapper, keep the list body)
  out = out.replace(RICHLIST_RE, (_raw, _attrs: string, body: string) => body.trim());

  // mark inline → plain text
  out = out.replace(MARK_RE, (_raw, text: string) => text);

  return out;
}
