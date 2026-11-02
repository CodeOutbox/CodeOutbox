// Bot protection on POST /f/:id, plus the first-party funnel admin page.
process.env.TOKEN_SECRET = "test-secret";
process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DIR = "/tmp/co-test-guard-" + Date.now();
process.env.EMAIL_TRANSPORT = "console";
process.env.ADMIN_EMAILS = "boss@ex.com";

import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

const { initDb, query, queryOne } = await import("../src/db.ts");
const { ingest } = await import("../src/routes/ingest.ts");
const { adminPage } = await import("../src/routes/admin.ts");
const { signSession } = await import("../src/tokens.ts");

await initDb();
const app = new Hono();
app.post("/f/:group", ingest);
app.get("/admin", adminPage);

const owner = await queryOne<{ id: number }>(`INSERT INTO accounts (email) VALUES ('boss@ex.com') RETURNING id`);
await query(`INSERT INTO groups (slug, name, public_id, owner_account_id) VALUES ('n', 'News', 'g1', $1)`, [owner!.id]);
await query(`INSERT INTO groups (slug, name, public_id, owner_account_id) VALUES ('m', 'More', 'g2', $1)`, [owner!.id]);

const BROWSER = {
  "user-agent": "Mozilla/5.0 (Macintosh) Chrome/130",
  origin: "https://site.example",
  accept: "application/json",
  "content-type": "application/json",
};

async function submit(list: string, body: Record<string, unknown>, headers: Record<string, string> = BROWSER, ip = "203.0.113.7") {
  const out: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    const res = await app.request(`/f/${list}`, {
      method: "POST",
      headers: { ...headers, "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
    return { res, json: (await res.json()) as any, mail: out.join("\n") };
  } finally {
    console.log = orig;
  }
}

const exists = async (email: string) =>
  !!(await queryOne(`SELECT 1 FROM subscribers WHERE email = $1`, [email]));
const blocked = async (reason: string) =>
  Number((await queryOne<{ c: number }>(`SELECT COUNT(*)::int c FROM events WHERE name='form_blocked' AND meta->>'reason'=$1`, [reason]))!.c);

test("a person filling in the form normally gets in, with signals recorded", async () => {
  const r = await submit("g1", { email: "ann@ex.com", _e: 4200 });
  assert.equal(r.json.status, "pending");
  assert.match(r.mail, /Confirm your subscription to News/);
  const s = await queryOne<{ signup_meta: any }>(`SELECT signup_meta FROM subscribers WHERE email='ann@ex.com'`);
  assert.deepEqual(s!.signup_meta, { js: true, elapsed_ms: 4200, origin: "site.example", client: "browser", low_trust: false });
});

test("too-fast and disposable submissions look successful but store and send nothing", async () => {
  const fast = await submit("g1", { email: "bot1@ex.com", _e: 300 }, BROWSER, "198.51.100.1");
  assert.equal(fast.json.ok, true);
  assert.equal(await exists("bot1@ex.com"), false);
  assert.equal(fast.mail, "", "no email sent");
  assert.equal(await blocked("too_fast"), 1);

  const temp = await submit("g1", { email: "x@mailinator.com", _e: 5000 }, BROWSER, "198.51.100.2");
  assert.equal(temp.json.ok, true);
  assert.equal(await exists("x@mailinator.com"), false);
  assert.equal(await blocked("disposable"), 1);
});

test("per-IP caps: 3 per list per day for browsers, 1 for scripts", async () => {
  for (const e of ["b1", "b2", "b3", "b4"]) await submit("g1", { email: `${e}@ex.com`, _e: 3000 }, BROWSER, "192.0.2.10");
  assert.deepEqual(
    await Promise.all(["b1", "b2", "b3", "b4"].map((e) => exists(`${e}@ex.com`))),
    [true, true, true, false],
  );

  const curl = { "user-agent": "curl/8.4", accept: "application/json", "content-type": "application/json" };
  await submit("g2", { email: "c1@ex.com" }, curl, "192.0.2.20");
  const second = await submit("g2", { email: "c2@ex.com" }, curl, "192.0.2.20");
  assert.equal(second.json.ok, true);
  assert.equal(await exists("c1@ex.com"), true);
  assert.equal(await exists("c2@ex.com"), false);
  assert.ok((await blocked("ip_cap_list")) >= 2);
});

test("resubmitting a pending address doesn't send another opt-in the same day", async () => {
  const again = await submit("g1", { email: "ann@ex.com", _e: 3000 });
  assert.equal(again.json.ok, true);
  assert.doesNotMatch(again.mail, /Confirm your subscription/);
});

test("low-trust signups get no reminder; trusted ones do", async () => {
  const reminders = await query<{ payload: string }>(`SELECT payload FROM jobs WHERE type = 'confirm.reminder'`);
  const ids = reminders.map((j) => Number(JSON.parse(j.payload).subscriberId));
  const ann = await queryOne<{ id: number }>(`SELECT id FROM subscribers WHERE email='ann@ex.com'`);
  const c1 = await queryOne<{ id: number }>(`SELECT id FROM subscribers WHERE email='c1@ex.com'`);
  assert.ok(ids.includes(Number(ann!.id)), "trusted signup gets a reminder");
  assert.ok(!ids.includes(Number(c1!.id)), "curl signup gets none");
  assert.equal(ids.filter((i) => i === Number(ann!.id)).length, 1, "resubmitting didn't queue a second one");
});

test("admin page: 404 for others, funnel for ADMIN_EMAILS", async () => {
  assert.equal((await app.request("/admin")).status, 404);
  const other = await queryOne<{ id: number }>(`INSERT INTO accounts (email) VALUES ('nope@ex.com') RETURNING id`);
  const asOther = await app.request("/admin", { headers: { cookie: `co_session=${await signSession(Number(other!.id))}` } });
  assert.equal(asOther.status, 404);

  const res = await app.request("/admin", { headers: { cookie: `co_session=${await signSession(Number(owner!.id))}` } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Funnel/);
  assert.match(html, /Blocked as bots/);
  assert.match(html, /too_fast 1/);
  assert.match(html, /boss@ex\.com/);
});
