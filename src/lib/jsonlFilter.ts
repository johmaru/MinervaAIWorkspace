/**
 * Generic JSONL line filters for bulk KB ingest.
 *
 * Domain-agnostic: any top-level string fields on each JSON object
 * (name, title, kind, tag, project, author, …).
 */

export type JsonlLineFilter = {
  /** Exact match: field === value (all keys must match). */
  equals?: Record<string, string>;
  /** Substring match: String(field).includes(value) (all keys must match). */
  contains?: Record<string, string>;
  /** Membership: field is one of the listed values. */
  in?: Record<string, string[]>;
  /**
   * OR across fields: at least one of `fields` contains `value`.
   * Useful for "愛" matching name OR title without knowing the schema.
   */
  anyFieldContains?: { fields: string[]; value: string };
};

export function jsonlLineMatches(
  obj: Record<string, unknown>,
  filter?: JsonlLineFilter | null,
): boolean {
  if (!filter) return true;

  if (filter.equals) {
    for (const [k, v] of Object.entries(filter.equals)) {
      if (String(obj[k] ?? "") !== v) return false;
    }
  }
  if (filter.contains) {
    for (const [k, v] of Object.entries(filter.contains)) {
      if (!String(obj[k] ?? "").includes(v)) return false;
    }
  }
  if (filter.in) {
    for (const [k, vals] of Object.entries(filter.in)) {
      if (!vals.includes(String(obj[k] ?? ""))) return false;
    }
  }
  if (filter.anyFieldContains) {
    const { fields, value } = filter.anyFieldContains;
    if (!value || fields.length === 0) return false;
    const hit = fields.some((f) => String(obj[f] ?? "").includes(value));
    if (!hit) return false;
  }
  return true;
}

/**
 * Parse agent-friendly "k=v,k2=v2" pairs into a record.
 * Values may contain `=` only if the whole value is after the first `=`.
 */
export function parseKeyValuePairs(raw: unknown): Record<string, string> {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v != null && String(v).length > 0) out[k] = String(v);
    }
    return out;
  }
  if (typeof raw !== "string") return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(/[,，]/)) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    const val = s.slice(eq + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

/**
 * Build a filter from tool string args.
 *
 * - filter_equals: "kind=note,project=alpha"
 * - filter_contains: "title=Q3"
 * - filter_any_fields + filter_any_value: fields "name,title,tags" value "contract"
 * - filter_json: full JsonlLineFilter as JSON string (overrides/merges last)
 */
export function buildJsonlFilterFromToolArgs(args: {
  filter_equals?: unknown;
  filter_contains?: unknown;
  filter_any_fields?: unknown;
  filter_any_value?: unknown;
  filter_json?: unknown;
}): JsonlLineFilter | undefined {
  const filter: JsonlLineFilter = {};
  const equals = parseKeyValuePairs(args.filter_equals);
  const contains = parseKeyValuePairs(args.filter_contains);
  if (Object.keys(equals).length) filter.equals = equals;
  if (Object.keys(contains).length) filter.contains = contains;

  const anyFieldsRaw = args.filter_any_fields;
  const anyValue =
    typeof args.filter_any_value === "string" ? args.filter_any_value.trim() : "";
  if (anyValue && anyFieldsRaw != null && String(anyFieldsRaw).trim()) {
    const fields = String(anyFieldsRaw)
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (fields.length) filter.anyFieldContains = { fields, value: anyValue };
  }

  if (typeof args.filter_json === "string" && args.filter_json.trim()) {
    try {
      const parsed = JSON.parse(args.filter_json) as JsonlLineFilter;
      if (parsed.equals) filter.equals = { ...filter.equals, ...parsed.equals };
      if (parsed.contains) filter.contains = { ...filter.contains, ...parsed.contains };
      if (parsed.in) filter.in = { ...filter.in, ...parsed.in };
      if (parsed.anyFieldContains) filter.anyFieldContains = parsed.anyFieldContains;
    } catch {
      throw new Error(`filter_json is not valid JSON: ${args.filter_json.slice(0, 120)}`);
    }
  }

  if (
    !filter.equals &&
    !filter.contains &&
    !filter.in &&
    !filter.anyFieldContains
  ) {
    return undefined;
  }
  return filter;
}

export function describeJsonlFilter(filter?: JsonlLineFilter | null): string {
  if (!filter) return "(none)";
  const parts: string[] = [];
  if (filter.equals) {
    parts.push(`eq(${Object.entries(filter.equals).map(([k, v]) => `${k}=${v}`).join(",")})`);
  }
  if (filter.contains) {
    parts.push(
      `contains(${Object.entries(filter.contains).map(([k, v]) => `${k}⊃${v}`).join(",")})`,
    );
  }
  if (filter.in) {
    parts.push(
      `in(${Object.entries(filter.in)
        .map(([k, v]) => `${k}∈[${v.join("|")}]`)
        .join(",")})`,
    );
  }
  if (filter.anyFieldContains) {
    parts.push(
      `any([${filter.anyFieldContains.fields.join("|")}]⊃${filter.anyFieldContains.value})`,
    );
  }
  return parts.join(" AND ") || "(none)";
}
