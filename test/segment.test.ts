import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWhere, matchesWhere, formatWhere } from "../src/segment.ts";
import { parseCampaign } from "../src/campaign.ts";

const m = (where: string, fields: Record<string, unknown> | null) => matchesWhere(fields, parseWhere(where));

test("where: equals, one-of, not-equals, set, not set", () => {
  assert.equal(m("plan=pro", { plan: "pro" }), true);
  assert.equal(m("plan=pro", { plan: "free" }), false);
  assert.equal(m("plan=pro", {}), false);
  assert.equal(m("lang=de|nl", { lang: "nl" }), true);
  assert.equal(m("lang=de|nl", { lang: "fr" }), false);
  assert.equal(m("plan!=free", { plan: "pro" }), true);
  assert.equal(m("plan!=free", {}), true, "unset counts as not-equal");
  assert.equal(m("plan!=free", { plan: "free" }), false);
  assert.equal(m("w_04_de", { w_04_de: "1" }), true);
  assert.equal(m("w_04_de", { w_04_pl: "1" }), false);
  assert.equal(m("!beta", {}), true);
  assert.equal(m("!beta", { beta: "yes" }), false);
  assert.equal(m("w_04_de", null), false);
});

test("where: comma means all must match; values are trimmed and case-insensitive", () => {
  const f = { lang: "DE ", w_04_de: "1", w_04_pl: "1" };
  assert.equal(m("lang=de, w_04_de", f), true);
  assert.equal(m("lang=de, w_09_de", f), false);
  assert.equal(m(" Lang = de ", { Lang: "de" }), true);
});

test("where: invalid input is rejected, empty means no filter", () => {
  assert.deepEqual(parseWhere(""), []);
  assert.deepEqual(parseWhere(undefined), []);
  assert.throws(() => parseWhere("plan="), /needs a value/);
  assert.throws(() => parseWhere("!plan=pro"), /only goes before/);
  assert.throws(() => parseWhere("9lives=1"), /invalid field name/);
  assert.throws(() => parseWhere("a=1,,b"), /invalid where/);
});

test("where: canonical form round-trips", () => {
  const s = formatWhere(parseWhere("lang = DE|nl ,beta, !gone, plan!=free"));
  assert.equal(s, "lang=de|nl, beta, !gone, plan!=free");
  assert.equal(formatWhere(parseWhere(s)), s);
});

test("campaign: where parses from frontmatter and keeps segment mails off the archive by default", () => {
  const seg = parseCampaign("---\nsubject: Out now\ngroup: notify\nwhere: w_04_de\n---\nBody.\n");
  assert.equal(formatWhere(seg.meta.where), "w_04_de");
  assert.equal(seg.meta.archive, false);
  const opted = parseCampaign("---\nsubject: Out\ngroup: notify\nwhere: w_04_de\narchive: true\n---\nBody.\n");
  assert.equal(opted.meta.archive, true);
  const plain = parseCampaign("---\nsubject: Hi\ngroup: news\n---\nBody.\n");
  assert.deepEqual(plain.meta.where, []);
  assert.equal(plain.meta.archive, true);
  assert.throws(() => parseCampaign("---\nsubject: Hi\ngroup: news\nwhere: =x\n---\nBody.\n"), /where/);
});
