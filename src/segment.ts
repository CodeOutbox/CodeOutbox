// Send to part of a list: `where:` in a campaign's frontmatter filters recipients
// on their custom fields (form inputs, API `fields`, CSV columns).
//
//   where: plan=pro                   field equals a value
//   where: lang=de|nl                 …one of several values
//   where: plan!=free                 field is not that value (or not set)
//   where: w_04_de                    field is set (any non-empty value)
//   where: !unsubscribed_from_promos  field is not set
//   where: lang=de, w_04_de           several conditions: all must match
//
// Values compare case-insensitively after trimming. The filter is part of the
// campaign source, so scheduled and resumed sends apply it too.

import { KEY_RE } from "./merge";

export interface Condition {
  key: string;
  op: "eq" | "ne" | "has" | "missing";
  values: string[]; // lowercased; for eq/ne only
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export function parseWhere(input: string | undefined): Condition[] {
  const src = (input ?? "").trim();
  if (!src) return [];
  return src.split(",").map((raw) => {
    const part = raw.trim();
    const m = /^(!?)([^=!\s]+)\s*(?:(!=|=)\s*(.*))?$/.exec(part);
    if (!m) throw new Error(`invalid where condition "${part}" (use key=value, key!=value, key or !key)`);
    const [, not, key, op, rhs] = m;
    if (!KEY_RE.test(key)) throw new Error(`invalid field name "${key}" in where`);
    if (!op) return { key, op: not ? "missing" : "has", values: [] };
    if (not) throw new Error(`invalid where condition "${part}" ("!" only goes before a bare field name)`);
    const values = rhs.split("|").map(norm).filter(Boolean);
    if (!values.length) throw new Error(`where condition "${part}" needs a value`);
    return { key, op: op === "=" ? "eq" : "ne", values };
  });
}

export function matchesWhere(
  fields: Record<string, unknown> | null | undefined,
  conds: Condition[],
): boolean {
  const f = fields ?? {};
  return conds.every((c) => {
    const v = norm(f[c.key]);
    switch (c.op) {
      case "has":
        return v !== "";
      case "missing":
        return v === "";
      case "eq":
        return c.values.includes(v);
      case "ne":
        return !c.values.includes(v);
    }
  });
}

// Canonical form: stable for idempotency hashing and readable in CLI/PR output.
export function formatWhere(conds: Condition[]): string {
  return conds
    .map((c) =>
      c.op === "has" ? c.key
        : c.op === "missing" ? `!${c.key}`
        : `${c.key}${c.op === "eq" ? "=" : "!="}${c.values.join("|")}`,
    )
    .join(", ");
}
