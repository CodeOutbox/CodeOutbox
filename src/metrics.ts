// First-party funnel events. GA4 only sees visitors who accept cookies (and not the
// many developers who block it), so the funnel's source of truth lives here: named
// events with an optional account and a small meta object — never an email or IP.
// Writes are fire-and-forget; a metrics hiccup must never break a request.

import type { Context } from "hono";
import { query } from "./db";

export type EventName =
  | "start_view"
  | "signup_requested"
  | "account_created"
  | "signin"
  | "list_created"
  | "provisional_created"
  | "provisional_claimed"
  | "import_csv"
  | "test_sent"
  | "form_blocked";

export function track(name: EventName, accountId: number | null = null, meta: Record<string, unknown> = {}): void {
  query(`INSERT INTO events (name, account_id, meta) VALUES ($1, $2, $3::jsonb)`, [
    name,
    accountId,
    JSON.stringify(meta),
  ]).catch(() => {});
}

// Which tool made a request: our npm package sends x-co-client (cli / mcp);
// a session cookie means the dashboard; anything else is the API directly.
export function clientOf(c: Context): string {
  const h = c.req.header("x-co-client") ?? "";
  if (/^codeoutbox-(cli|mcp)\b/.test(h)) return h.split("/")[0].replace("codeoutbox-", "");
  if ((c.req.header("cookie") ?? "").includes("co_session=")) return "dashboard";
  return "api";
}
