const CALLOUT_RE = /:::callout\{([^}]*)\}\n([\s\S]*?)\n:::/g;
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

export function convertRichBlocksForExport(content: string): string {
  let out = content;

  // callout → Obsidian native: > [!type] Title\n> bodyline
  out = out.replace(CALLOUT_RE, (_raw, attrsRaw: string, body: string) => {
    const a = parseAttrs(attrsRaw);
    const type = CALLOUT_TYPES.has(a.type) ? a.type : "note";
    const header = a.title ? `> [!${type}] ${a.title}` : `> [!${type}]`;
    const bodyLines = body.split("\n").map((l: string) => `> ${l}`.trimEnd());
    return [header, ...bodyLines].join("\n");
  });

  // richlist → plain list (strip the wrapper, keep the list body)
  out = out.replace(RICHLIST_RE, (_raw, _attrs: string, body: string) => body.trim());

  // mark inline → plain text
  out = out.replace(MARK_RE, (_raw, text: string) => text);

  return out;
}
