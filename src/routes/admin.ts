// GET /admin — the operator's view of the funnel, from first-party data (tables +
// the events log), so it shows what GA can't: people who declined cookies, CLI and
// MCP use, blocked bot signups. Only for ADMIN_EMAILS; everyone else gets a 404.

import type { Context } from "hono";
import { query, queryOne } from "../db";
import { getAccountId } from "../auth";
import { config } from "../config";
import { messagePage } from "../pages";
import { escapeHtml } from "../email/shell";

async function isAdmin(c: Context): Promise<boolean> {
  const id = await getAccountId(c);
  if (!id || !config.adminEmails.length) return false;
  const a = await queryOne<{ email: string }>(`SELECT email FROM accounts WHERE id = $1`, [id]);
  return !!a && config.adminEmails.includes(a.email.toLowerCase());
}

const n = (v: unknown) => Number(v ?? 0);

async function funnel(days: number) {
  const since = `now() - make_interval(days => ${days})`;
  const ev = async (name: string) =>
    n((await queryOne<{ c: number }>(`SELECT COUNT(*)::int c FROM events WHERE name = $1 AND at > ${since}`, [name]))?.c);
  // Cohort: accounts created in the window, and how far each got.
  const cohort = await queryOne<{ accounts: number; lists: number; subs: number; sent: number }>(
    `SELECT COUNT(*)::int accounts,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM groups g WHERE g.owner_account_id = a.id))::int lists,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM subscribers s JOIN groups g ON g.id = s.group_id
                                           WHERE g.owner_account_id = a.id))::int subs,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM broadcasts b WHERE b.account_id = a.id AND b.status = 'sent'))::int sent
       FROM accounts a WHERE a.created_at > ${since}`,
  );
  const form = await queryOne<{ total: number; confirmed: number }>(
    `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status = 'confirmed')::int confirmed
       FROM subscribers WHERE source = 'form' AND created_at > ${since}`,
  );
  return {
    steps: [
      ["Start page views", await ev("start_view")],
      ["Sign-in links requested", await ev("signup_requested")],
      ["Accounts created", n(cohort?.accounts)],
      ["…created a list", n(cohort?.lists)],
      ["…got a first subscriber", n(cohort?.subs)],
      ["…sent an email", n(cohort?.sent)],
    ] as [string, number][],
    provisional: [await ev("provisional_created"), await ev("provisional_claimed")],
    form: [n(form?.total), n(form?.confirmed), await ev("form_blocked")],
    signins: await ev("signin"),
  };
}

export async function adminPage(c: Context) {
  if (!(await isAdmin(c))) return c.notFound();
  const [d7, d30] = [await funnel(7), await funnel(30)];

  const blocked = await query<{ reason: string; c: number }>(
    `SELECT meta->>'reason' reason, COUNT(*)::int c FROM events
      WHERE name = 'form_blocked' AND at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`,
  );
  const clients = await query<{ name: string; client: string; c: number }>(
    `SELECT name, COALESCE(meta->>'client', '-') client, COUNT(*)::int c FROM events
      WHERE name IN ('list_created','provisional_created','import_csv','test_sent') AND at > now() - interval '30 days'
      GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
  );
  const accounts = await query<{ email: string; created: string; lists: number; subs: number; sent: number }>(
    `SELECT a.email, to_char(a.created_at, 'YYYY-MM-DD') created,
            (SELECT COUNT(*) FROM groups g WHERE g.owner_account_id = a.id)::int lists,
            (SELECT COUNT(*) FROM subscribers s JOIN groups g ON g.id = s.group_id
              WHERE g.owner_account_id = a.id AND s.status = 'confirmed')::int subs,
            (SELECT COUNT(*) FROM broadcasts b WHERE b.account_id = a.id AND b.status = 'sent')::int sent
       FROM accounts a ORDER BY a.created_at DESC LIMIT 25`,
  );

  const pct = (a: number, b: number) => (b > 0 ? ` <span class="muted">${Math.round((100 * a) / b)}%</span>` : "");
  const funnelRows = d30.steps
    .map(([label, v30], i) => {
      const v7 = d7.steps[i][1];
      const prev30 = i > 0 ? d30.steps[i - 1][1] : 0;
      return `<tr><td>${label}</td><td style="text-align:right">${v7}</td><td style="text-align:right">${v30}${i > 0 ? pct(v30, prev30) : ""}</td></tr>`;
    })
    .join("");
  const rows = (cells: (string | number)[][]) =>
    cells.map((r) => `<tr>${r.map((x, i) => `<td${i ? ' style="text-align:right"' : ""}>${typeof x === "number" ? x : escapeHtml(x)}</td>`).join("")}</tr>`).join("");

  const html =
    `<div class="row"><h1>Admin</h1><span class="muted" style="font-size:13px">first-party data · no cookies</span></div>` +
    `<div class="card"><h2>Funnel</h2><table><thead><tr><th></th><th style="text-align:right">7 days</th><th style="text-align:right">30 days</th></tr></thead><tbody>${funnelRows}` +
    `<tr><td class="muted">Returning sign-ins</td><td style="text-align:right">${d7.signins}</td><td style="text-align:right">${d30.signins}</td></tr></tbody></table>` +
    `<p class="muted" style="font-size:13px;margin:10px 0 0">Page views and sign-in requests count events (logged since this page shipped). The account steps are a cohort: accounts created in the window and how far each got.</p></div>` +
    `<div class="card"><h2>No-account lists (npx / MCP)</h2><table><tbody>${rows([
      ["Created", d7.provisional[0], d30.provisional[0]],
      ["Claimed", d7.provisional[1], d30.provisional[1]],
    ])}</tbody></table></div>` +
    `<div class="card"><h2>Signup forms</h2><table><thead><tr><th></th><th style="text-align:right">7 days</th><th style="text-align:right">30 days</th></tr></thead><tbody>${rows([
      ["New form signups", d7.form[0], d30.form[0]],
      ["…confirmed", d7.form[1], d30.form[1]],
      ["Blocked as bots", d7.form[2], d30.form[2]],
    ])}</tbody></table>` +
    (blocked.length ? `<p class="muted" style="font-size:13px;margin:10px 0 0">Blocked (30 days): ${blocked.map((b) => `${escapeHtml(b.reason)} ${b.c}`).join(" · ")}</p>` : "") +
    `</div>` +
    `<div class="card"><h2>Which tools (30 days)</h2><table><tbody>${
      clients.length ? rows(clients.map((x) => [`${x.name} · ${x.client}`, x.c])) : `<tr><td class="muted">Nothing yet.</td></tr>`
    }</tbody></table></div>` +
    `<div class="card"><h2>Recent accounts</h2><table><thead><tr><th>Email</th><th style="text-align:right">Joined</th><th style="text-align:right">Lists</th><th style="text-align:right">Subs</th><th style="text-align:right">Sent</th></tr></thead><tbody>${rows(
      accounts.map((a) => [a.email, a.created, a.lists, a.subs, a.sent]),
    )}</tbody></table></div>`;

  return c.html(messagePage("Admin", html));
}
