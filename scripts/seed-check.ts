// Inbox-placement check against our own seed mailboxes. Sends a real sign-in
// email (shared domain, same path as opt-in confirmations) to a plus-address of
// each seed, then reports where it landed and how the provider judged SPF/DKIM/DMARC.
//
//   npx tsx scripts/seed-check.ts                 # against app.codeoutbox.com
//   CO_URL=http://localhost:3000 npx tsx scripts/seed-check.ts
//
// Credentials live outside the repo in ~/.config/codeoutbox/seeds.env (SEEDS_ENV
// to override): GMAIL_SEED_USER, GMAIL_SEED_APP_PASSWORD, OUTLOOK_SEED_USER,
// OUTLOOK_SEED_CLIENT_ID.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { ImapFlow } from "imapflow";

const base = (process.env.CO_URL || "https://app.codeoutbox.com").replace(/\/$/, "");
const TIMEOUT_MS = 180_000;
const POLL_MS = 5_000;

function loadEnv(): Record<string, string> {
  const path = process.env.SEEDS_ENV || `${homedir()}/.config/codeoutbox/seeds.env`;
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// seed1@gmail.com → seed1+co-<nonce>@gmail.com, so each run matches only its own mail.
function plus(addr: string, tag: string): string {
  const [local, domain] = addr.split("@");
  return `${local}+${tag}@${domain}`;
}

interface Placement {
  folder: string; // "Primary", "Promotions", "Updates", "Spam", …
  ms: number;
  auth: string; // spf=… dkim=… dmarc=…
}

function summarizeAuth(header: string): string {
  const pick = (k: string) => header.match(new RegExp(`\\b${k}=(\\w+)`, "i"))?.[1] ?? "?";
  return `spf=${pick("spf")} dkim=${pick("dkim")} dmarc=${pick("dmarc")}`;
}

async function requestSignin(to: string): Promise<void> {
  const res = await fetch(`${base}/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: to }),
  });
  if (!res.ok) throw new Error(`POST /signup → ${res.status} ${await res.text()}`);
}

async function checkGmail(user: string, pass: string, to: string, sentAt: number): Promise<Placement | null> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  await client.connect();
  try {
    const boxes = await client.list();
    const spam = boxes.find((b) => b.specialUse === "\\Junk")?.path ?? "[Gmail]/Spam";

    // Inbox tabs are Gmail search categories, not folders; ask for each in turn.
    const where: [string, string, string][] = [
      ["INBOX", "Primary", "category:primary"],
      ["INBOX", "Promotions", "category:promotions"],
      ["INBOX", "Updates", "category:updates"],
      ["INBOX", "Social", "category:social"],
      ["INBOX", "Inbox (other tab)", ""],
      [spam, "Spam", ""],
    ];
    while (Date.now() - sentAt < TIMEOUT_MS) {
      for (const [box, label, raw] of where) {
        const lock = await client.getMailboxLock(box);
        try {
          const uids = await client.search({ gmraw: `to:${to} ${raw}`.trim() }, { uid: true });
          if (uids && uids.length) {
            const msg = await client.fetchOne(String(uids[0]), { headers: ["authentication-results"] }, { uid: true });
            const auth = msg && msg.headers ? summarizeAuth(msg.headers.toString()) : "no auth header";
            await client.messageFlagsAdd(String(uids[0]), ["\\Seen"], { uid: true });
            return { folder: label, ms: Date.now() - sentAt, auth };
          }
        } finally {
          lock.release();
        }
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return null;
  } finally {
    await client.logout();
  }
}

async function main() {
  const env = loadEnv();
  const tag = `co-${randomBytes(4).toString("hex")}`;
  console.log(`seed-check via ${base} (tag ${tag})\n`);

  const checks: Promise<string>[] = [];

  if (env.GMAIL_SEED_USER && env.GMAIL_SEED_APP_PASSWORD) {
    const to = plus(env.GMAIL_SEED_USER, tag);
    await requestSignin(to);
    const sentAt = Date.now();
    checks.push(
      checkGmail(env.GMAIL_SEED_USER, env.GMAIL_SEED_APP_PASSWORD.replace(/\s/g, ""), to, sentAt).then((p) =>
        p
          ? `${p.folder === "Spam" ? "✗" : "✔"} gmail    ${p.folder.padEnd(12)} ${(p.ms / 1000).toFixed(0)}s  ${p.auth}`
          : `✗ gmail    not delivered within ${TIMEOUT_MS / 1000}s (check the MTA log for a bounce)`,
      ),
    );
  } else {
    checks.push(Promise.resolve("- gmail    not configured"));
  }

  // Outlook needs OAuth (Graph, device-code login); added once the app registration exists.
  checks.push(Promise.resolve(env.OUTLOOK_SEED_CLIENT_ID ? "- outlook  not implemented yet" : "- outlook  not configured"));

  for (const line of await Promise.all(checks)) console.log(line);
}

main().catch((err) => {
  // imapflow's message is just "Command failed"; the server's reason is in responseText.
  console.error(err instanceof Error ? [err.message, (err as any).responseText].filter(Boolean).join(": ") : err);
  process.exit(1);
});
