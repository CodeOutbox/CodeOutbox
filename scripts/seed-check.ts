// Inbox-placement check against our own seed mailboxes. Sends a real sign-in
// email (shared domain, same path as opt-in confirmations) to a plus-address of
// each seed, then reports where it landed and how the provider judged SPF/DKIM/DMARC.
//
//   npx tsx scripts/seed-check.ts                 # against app.codeoutbox.com
//   CO_URL=http://localhost:3000 npx tsx scripts/seed-check.ts
//
// Credentials live outside the repo in ~/.config/codeoutbox/seeds.env (SEEDS_ENV
// to override): GMAIL_SEED_USER, GMAIL_SEED_APP_PASSWORD, OUTLOOK_SEED_USER.
//
// Outlook has no mailbox access (Graph needs an Azure tenant), so it's judged from
// our own Postfix log over SSH: accepted vs blocked, not Inbox vs Junk. The MTA
// host is SEED_MTA_SSH (default: codeoutbox-mta).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ImapFlow } from "imapflow";

const base = (process.env.CO_URL || "https://app.codeoutbox.com").replace(/\/$/, "");
const mtaHost = process.env.SEED_MTA_SSH || "codeoutbox-mta";
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

interface LogResult {
  status: "sent" | "bounced" | "deferred";
  relay: string;
  reply: string; // the receiving server's answer, e.g. "250 2.6.0 …" or "550 5.7.1 …"
}

// Latest Postfix delivery line for this recipient. Returns null until the message
// has been handed to the remote server at least once.
async function mtaLog(to: string): Promise<LogResult | null> {
  const { stdout } = await promisify(execFile)(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", mtaHost, `grep -F 'to=<${to}>' /var/log/postfix.log || true`],
    { timeout: 30_000 },
  );
  const line = stdout.trim().split("\n").filter((l) => /status=(sent|bounced|deferred)/.test(l)).pop();
  if (!line) return null;
  const status = line.match(/status=(\w+)/)![1] as LogResult["status"];
  const relay = line.match(/relay=([^\s,\[]+)/)?.[1] ?? "?";
  const reply = (line.match(/status=\w+ \((?:host \S+ said: )?(.*)\)\s*$/)?.[1] ?? "").replace(/\s+/g, " ");
  return { status, relay, reply };
}

// Waits for a final answer; a deferral keeps waiting (Postfix retries) and is
// reported as-is if nothing better comes before the timeout.
async function checkViaLog(to: string, sentAt: number): Promise<LogResult | null> {
  let last: LogResult | null = null;
  while (Date.now() - sentAt < TIMEOUT_MS) {
    last = (await mtaLog(to)) ?? last;
    if (last && last.status !== "deferred") return last;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return last;
}

function describeLog(provider: string, r: LogResult | null): string {
  const name = provider.padEnd(8);
  if (!r) return `✗ ${name} no delivery attempt in the MTA log within ${TIMEOUT_MS / 1000}s`;
  const reply = r.reply.length > 140 ? `${r.reply.slice(0, 140)}…` : r.reply;
  if (r.status === "sent") return `✔ ${name} accepted    ${r.relay}  (${reply})`;
  return `✗ ${name} ${r.status.padEnd(11)} ${r.relay}  ${reply}`;
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
      checkGmail(env.GMAIL_SEED_USER, env.GMAIL_SEED_APP_PASSWORD.replace(/\s/g, ""), to, sentAt).then(async (p) =>
        p
          ? `${p.folder === "Spam" ? "✗" : "✔"} gmail    ${p.folder.padEnd(12)} ${(p.ms / 1000).toFixed(0)}s  ${p.auth}`
          : // Not in the mailbox: the MTA log says whether Gmail refused it.
            describeLog("gmail", await mtaLog(to).catch(() => null)),
      ),
    );
  } else {
    checks.push(Promise.resolve("- gmail    not configured"));
  }

  if (env.OUTLOOK_SEED_USER) {
    const to = plus(env.OUTLOOK_SEED_USER, tag);
    await requestSignin(to);
    const sentAt = Date.now();
    checks.push(checkViaLog(to, sentAt).then((r) => describeLog("outlook", r)));
  } else {
    checks.push(Promise.resolve("- outlook  not configured"));
  }

  for (const line of await Promise.all(checks)) console.log(line);
}

main().catch((err) => {
  // imapflow's message is just "Command failed"; the server's reason is in responseText.
  console.error(err instanceof Error ? [err.message, (err as any).responseText].filter(Boolean).join(": ") : err);
  process.exit(1);
});
