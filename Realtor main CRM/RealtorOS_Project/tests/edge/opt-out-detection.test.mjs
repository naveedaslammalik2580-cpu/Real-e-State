// Phase 4E.3: strict, rule-based detection of a reply that is an opt-out
// request. Exact phrases only; never a keyword inside a longer sentence.
import { test } from "node:test";
import assert from "node:assert/strict";

const rd = await import(new URL("../../supabase/functions/_shared/reply-detection.ts", import.meta.url).href);
const { isOptOutRequest, OPT_OUT_PHRASES } = rd;

const KEYWORDS = [
  "unsubscribe", "unsubscribe me", "please unsubscribe", "please unsubscribe me",
  "stop", "remove", "remove me", "please remove me", "opt out", "optout", "opt me out",
];
const QUOTED = [
  "",
  "On Mon, Sep 28, 2026 at 10:00 AM Agent Smith <agent@example.org> wrote:",
  "> Hi Pat, just following up on the listing.",
  "> Don't want these emails? Unsubscribe here: https://example.org/u",
].join("\n");

test("the phrase list is exactly the specified set", () => {
  assert.deepEqual([...OPT_OUT_PHRASES].sort(), [...KEYWORDS].sort());
});

for (const k of KEYWORDS) {
  test(`opt-out: "${k}" — plain, mixed case, punctuation, quoted history, subject`, () => {
    const mixed = k.replace(/(^|\s)(\w)/g, (m, sp, c) => sp + c.toUpperCase());
    assert.equal(isOptOutRequest("Re: Following up", k), true, "plain body");
    assert.equal(isOptOutRequest("Re: Following up", k.toUpperCase()), true, "upper case");
    assert.equal(isOptOutRequest("Re: Following up", `${mixed}!`), true, "mixed case + !");
    assert.equal(isOptOutRequest("Re: Following up", `  ${mixed}.  `), true, "whitespace + .");
    assert.equal(isOptOutRequest("Re: Following up", `${k}\n${QUOTED}`), true, "with quoted history");
    assert.equal(isOptOutRequest("Re: Following up", `\n\n${k}\r\n\r\n-- \nPat Lee\nSent from my phone`), true, "with signature");
    assert.equal(isOptOutRequest(`Re: ${mixed}`, "Thanks."), true, "subject with Re:");
    assert.equal(isOptOutRequest(`RE: Fwd: ${k}!!`, ""), true, "subject with RE: Fwd:");
    assert.equal(isOptOutRequest(k, null), true, "bare subject, no body");
  });
}

test("opt-out variants of punctuation", () => {
  assert.equal(isOptOutRequest("", "Opt-out"), true);
  assert.equal(isOptOutRequest("", "UNSUBSCRIBE!!!"), true);
  assert.equal(isOptOutRequest("", "“Stop”"), true);
  assert.equal(isOptOutRequest("", "Please, remove me."), true);
});

test("HTML-only reply: first line of the person's text, quoted block ignored", () => {
  const html = '<div dir="ltr">Unsubscribe</div><br><div class="gmail_quote"><div>On Mon, Sep 28 Agent wrote:</div><blockquote>Hi Pat, stop by the open house</blockquote></div>';
  assert.equal(isOptOutRequest("Re: Open house", null, html), true);
  const normal = '<div>Yes, see you at 5</div><blockquote>unsubscribe</blockquote>';
  assert.equal(isOptOutRequest("Re: Open house", null, normal), false);
  assert.equal(isOptOutRequest("Re: Open house", null, "data:text/html;base64,VW5zdWJzY3JpYmU="), false);
});

test("non-matches: keywords inside longer sentences are normal replies", () => {
  const normal = [
    "yes interested but stop calling after 6pm",
    "yes I'm interested, stop by at 5",
    "Please don't unsubscribe me, I love these",
    "Can you remove me from the Tuesday showing and add me to Thursday?",
    "stop stop",
    "unsubscribe from the newsletter but keep the listings",
    "opt out of texts only",
    "Stop.\nActually never mind, call me.", // first line matches -> see below
  ];
  for (const t of normal.slice(0, 7)) assert.equal(isOptOutRequest("Re: Following up", t), false, t);
  assert.equal(isOptOutRequest("Re: Stop by the open house", "Sounds good"), false, "subject with extra words");
  assert.equal(isOptOutRequest("Re: Following up — unsubscribe", "ok"), false, "keyword appended to a subject");
});

test("the rule is the FIRST line only: a matching first line counts, a later one does not", () => {
  assert.equal(isOptOutRequest("Re: hi", "Stop.\nActually never mind, call me."), true);
  assert.equal(isOptOutRequest("Re: hi", "Hi Agent,\nunsubscribe"), false);
});

test("non-matches: empty, signature-only, quoted-only bodies", () => {
  assert.equal(isOptOutRequest("Re: Following up", ""), false);
  assert.equal(isOptOutRequest("Re: Following up", "   \n\n  "), false);
  assert.equal(isOptOutRequest("Re: Following up", null), false);
  assert.equal(isOptOutRequest(undefined, undefined), false);
  assert.equal(isOptOutRequest("Re: Following up", "-- \nPat Lee\nRealtor"), false);
  assert.equal(isOptOutRequest("Re: Following up", "Sent from my iPhone"), false);
  assert.equal(isOptOutRequest("Re: Following up", "> unsubscribe\n> stop"), false);
  assert.equal(isOptOutRequest("Re: Following up", "On Mon, Sep 28, 2026, Agent Smith\nwrote:\n> stop"), false);
  assert.equal(isOptOutRequest("Re: Following up", "-----Original Message-----\nFrom: Agent\nunsubscribe"), false);
});

test("auto-replies are filtered before opt-out detection (never opt-outs)", () => {
  // An out-of-office whose body happens to be "stop" is still an automatic
  // reply: the webhook checks autoReplyReason first and never reaches
  // isOptOutRequest for it.
  assert.equal(rd.autoReplyReason({ "auto-submitted": "auto-replied" }, "Re: hi", "a@b.com"), "auto_submitted");
  assert.equal(rd.autoReplyReason({}, "Automatic reply: stop", "a@b.com"), "auto_subject");
});
