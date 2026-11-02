// Bot protection for the public form endpoint, without a captcha. Fake signups
// aren't just noise: each one makes us email a stranger (opt-in + reminder), and
// their spam complaints cost the sending reputation the whole product relies on.
//
// Signals: the hidden honeypot (checked in ingest), `_e` = ms between form load
// and submit (sent by our form scripts), Origin/Referer headers (browsers send
// them), the user agent, and how many signups an IP made in the last day.
// A blocked submission gets the normal "check your inbox" answer — bots learn
// nothing — but nothing is stored and no email goes out.

import { queryOne } from "./db";

export interface SignupSignals {
  js: boolean; // came from one of our form scripts (sent _e)
  elapsed_ms: number | null;
  origin: string | null; // host of Origin/Referer
  client: "browser" | "script" | "unknown";
  low_trust: boolean;
}

export type Verdict =
  | { ok: true; signals: SignupSignals }
  | { ok: false; reason: string; signals: SignupSignals };

const MIN_HUMAN_MS = 1200; // load → submit; even autofill + click takes longer
const CAPS = {
  perList: { normal: 3, low: 1 }, // new signups per IP per list per 24h
  total: { normal: 10, low: 3 }, //  …across all lists
};

const SCRIPT_UA = /curl|wget|python|go-http-client|axios|node-fetch|undici|okhttp|java\/|libwww|scrapy|httpclient|php|ruby|perl|powershell|headless/i;

// Throwaway inboxes. Not exhaustive; catches the common ones bots and drive-bys use.
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "10minutemail.com",
  "10minutemail.net", "tempmail.com", "temp-mail.org", "tempmailo.com", "yopmail.com", "yopmail.net",
  "trashmail.com", "getnada.com", "nada.email", "dispostable.com", "maildrop.cc", "mailnesia.com",
  "throwawaymail.com", "fakeinbox.com", "mintemail.com", "mohmal.com", "emailondeck.com", "spamgourmet.com",
  "mailcatch.com", "tempinbox.com", "burnermail.io", "moakt.com", "tmail.ws", "tmpmail.org", "tmpmail.net",
  "emailfake.com", "inboxkitten.com", "mail.tm", "mailpoof.com", "discard.email", "33mail.com",
  "trbvm.com", "byom.de", "spambox.us", "grr.la", "pokemail.net", "harakirimail.com",
]);

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function readSignals(
  headers: (name: string) => string | undefined,
  body: Record<string, unknown>,
): SignupSignals {
  const e = Number(body._e);
  const elapsed = Number.isFinite(e) && e >= 0 ? Math.round(e) : null;
  const origin = hostOf(headers("origin")) ?? hostOf(headers("referer"));
  const ua = headers("user-agent") ?? "";
  const client = !ua ? "unknown" : SCRIPT_UA.test(ua) ? "script" : "browser";
  const js = elapsed !== null;
  return {
    js,
    elapsed_ms: elapsed,
    origin,
    client,
    low_trust: client !== "browser" || (!origin && !js),
  };
}

export async function checkSignup(opts: {
  email: string;
  ip: string | null;
  groupId: number;
  signals: SignupSignals;
}): Promise<Verdict> {
  const { email, ip, groupId, signals } = opts;
  const domain = email.split("@")[1] ?? "";
  if (DISPOSABLE.has(domain)) return { ok: false, reason: "disposable", signals };
  if (signals.elapsed_ms !== null && signals.elapsed_ms < MIN_HUMAN_MS) {
    return { ok: false, reason: "too_fast", signals };
  }
  if (ip) {
    const tier = signals.low_trust ? "low" : "normal";
    const n = await queryOne<{ list: number; total: number }>(
      `SELECT COUNT(*) FILTER (WHERE group_id = $2)::int AS list, COUNT(*)::int AS total
         FROM subscribers
        WHERE consent_ip = $1 AND created_at > now() - interval '24 hours'`,
      [ip, groupId],
    );
    if (Number(n?.list ?? 0) >= CAPS.perList[tier]) return { ok: false, reason: "ip_cap_list", signals };
    if (Number(n?.total ?? 0) >= CAPS.total[tier]) return { ok: false, reason: "ip_cap", signals };
  }
  return { ok: true, signals };
}
