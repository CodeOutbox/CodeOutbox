// Coming back after unsubscribing: a new form signup + confirmed opt-in brings the
// subscriber back; bounced/complained addresses stay off; an old confirm link can't.
process.env.TOKEN_SECRET = "test-secret";
process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DIR = "/tmp/co-test-resub-" + Date.now();
process.env.EMAIL_TRANSPORT = "console";

import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

const { initDb, query, queryOne } = await import("../src/db.ts");
const { ingest } = await import("../src/routes/ingest.ts");
const { confirm } = await import("../src/routes/confirm.ts");
const { unsubscribeGet } = await import("../src/routes/unsubscribe.ts");
const { signToken, signUnsub } = await import("../src/tokens.ts");
const { sendBroadcast } = await import("../src/broadcast.ts");

await initDb();
const app = new Hono();
app.post("/f/:group", ingest);
app.get("/confirm/:token", confirm);
app.get("/unsubscribe/:token", unsubscribeGet);

const acct = await queryOne<{ id: number }>("INSERT INTO accounts (email) VALUES ('owner@ex.com') RETURNING id");
const accountId = Number(acct!.id);
for (const [slug, pub] of [["news", "pubnews"], ["notify", "pubnotify"]]) {
  await query("INSERT INTO groups (slug, public_id, owner_account_id, name) VALUES ($1, $2, $3, $1)", [slug, pub, accountId]);
}

async function capture(fn: () => Promise<unknown>) {
  const out: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    const r = await fn();
    return { r: r as Response, out: out.join("\n") };
  } finally {
    console.log = orig;
  }
}

const signup = (pub: string, email: string) =>
  capture(() =>
    app.request(`/f/${pub}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "Mozilla/5.0" },
      body: `email=${encodeURIComponent(email)}&_e=4000`,
    }),
  );

async function addConfirmed(slug: string, email: string): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO subscribers (group_id, email, status, optin_sent_at, consent_timestamp)
     SELECT id, $2, 'confirmed', now() - interval '3 days', now() - interval '3 days' FROM groups WHERE slug = $1
     RETURNING id`,
    [slug, email],
  );
  return Number(row!.id);
}

const statusOf = async (id: number) =>
  (await queryOne<{ status: string }>("SELECT status FROM subscribers WHERE id = $1", [id]))!.status;
const suppressed = async (email: string) =>
  (await queryOne<{ reason: string }>("SELECT reason FROM suppressions WHERE account_id = $1 AND email = $2", [accountId, email]))?.reason ?? null;

test("unsubscribed → signs up again → new opt-in → confirmed, suppression lifted, gets broadcasts", async () => {
  const id = await addConfirmed("news", "back@ex.com");
  await app.request(`/unsubscribe/${await signUnsub(id)}`);
  assert.equal(await statusOf(id), "unsubscribed");
  assert.equal(await suppressed("back@ex.com"), "unsubscribe");

  const { r, out } = await signup("pubnews", "back@ex.com");
  assert.deepEqual(await r.json(), { ok: true, status: "pending" });
  assert.equal(await statusOf(id), "pending");
  const consent = await queryOne<{ consent_timestamp: string | null }>("SELECT consent_timestamp FROM subscribers WHERE id = $1", [id]);
  assert.equal(consent!.consent_timestamp, null, "old consent is cleared until they confirm again");
  assert.equal(await suppressed("back@ex.com"), "unsubscribe", "still suppressed until confirmed");

  const link = /\/confirm\/([\w.-]+)/.exec(out);
  assert.ok(link, "a fresh opt-in email went out");
  const page = await app.request(`/confirm/${link![1]}`);
  assert.notEqual(page.status, 400);
  assert.equal(await statusOf(id), "confirmed");
  assert.equal(await suppressed("back@ex.com"), null);

  const sent = await capture(() => sendBroadcast("---\nsubject: Back\ngroup: news\n---\nWelcome back to the list, good to have you.\n", accountId));
  assert.match(sent.out, /To:\s+back@ex\.com/);
});

test("left list A, confirms on list B: B's mail arrives, A stays unsubscribed", async () => {
  const a = await addConfirmed("news", "two@ex.com");
  await app.request(`/unsubscribe/${await signUnsub(a)}`);

  const { out } = await signup("pubnotify", "two@ex.com");
  const link = /\/confirm\/([\w.-]+)/.exec(out)!;
  await app.request(`/confirm/${link[1]}`);
  assert.equal(await suppressed("two@ex.com"), null);

  const b = await capture(() => sendBroadcast("---\nsubject: Out now\ngroup: notify\n---\nThe edition you asked about is out now.\n", accountId));
  assert.match(b.out, /To:\s+two@ex\.com/);
  assert.equal(await statusOf(a), "unsubscribed");
  const n = await capture(() => sendBroadcast("---\nsubject: News\ngroup: news\n---\nSome news for the whole list this week.\n", accountId));
  assert.doesNotMatch(n.out, /To:\s+two@ex\.com/);
});

test("bounced or complained addresses get the usual answer but no mail", async () => {
  for (const [email, status, reason] of [["bounce@ex.com", "bounced", "bounce"], ["spam@ex.com", "complained", "complaint"]]) {
    const id = await addConfirmed("news", email);
    await query("UPDATE subscribers SET status = $2 WHERE id = $1", [id, status]);
    await query("INSERT INTO suppressions (account_id, email, reason) VALUES ($1, $2, $3)", [accountId, email, reason]);
    const { r, out } = await signup("pubnews", email);
    assert.deepEqual(await r.json(), { ok: true, status: "pending" });
    assert.doesNotMatch(out, /\/confirm\//, `no opt-in to a ${reason} address`);
    assert.equal(await statusOf(id), status);
  }
  // Unsubscribed, but the address later bounced: still no mail.
  const id = await addConfirmed("news", "both@ex.com");
  await query("UPDATE subscribers SET status = 'unsubscribed' WHERE id = $1", [id]);
  await query("INSERT INTO suppressions (account_id, email, reason) VALUES ($1, 'both@ex.com', 'bounce')", [accountId]);
  const { out } = await signup("pubnews", "both@ex.com");
  assert.doesNotMatch(out, /\/confirm\//);
  assert.equal(await statusOf(id), "unsubscribed");
});

test("a confirm link from before unsubscribing can't bring someone back", async () => {
  const id = await addConfirmed("news", "old@ex.com");
  const oldLink = await signToken(id, "confirm");
  await app.request(`/unsubscribe/${await signUnsub(id)}`);
  const res = await app.request(`/confirm/${oldLink}`);
  assert.equal(res.status, 400);
  assert.equal(await statusOf(id), "unsubscribed");
  assert.equal(await suppressed("old@ex.com"), "unsubscribe");
});
