// Phase 4H: rule-based detection of a "hot" reply (buying/selling intent).
// Returns a reason code only; negations and opt-outs are never hot; quoted
// history, signatures and the subject are ignored.
import { test } from "node:test";
import assert from "node:assert/strict";

const rd = await import(new URL("../../supabase/functions/_shared/reply-detection.ts", import.meta.url).href);
const { hotReplyReason, ownReplyText, HOT_REASONS } = rd;

const SUBJECT = "Re: Following up on 12 Oak Street";
const QUOTED = [
  "",
  "On Mon, Sep 28, 2026 at 10:00 AM Agent Smith <agent@example.org> wrote:",
  "> Hi Pat, would you like to book a viewing? The asking price is negotiable",
  "> and it's still available. Call me any time.",
].join("\n");

const HOT = {
  viewing: [
    "Can we schedule a viewing this weekend?",
    "I'd love to see the house on Saturday.",
    "Could we book a showing?",
    "Is a virtual tour possible?",
    "We'd like to come and see it.",
    "Can I visit the property tomorrow?",
  ],
  offer: [
    "We want to make an offer.",
    "I'd like to put in an offer on the house.",
    "Our offer is ready to go.",
    "Can I submit a bid?",
  ],
  ready: [
    "We are ready to buy.",
    "I'm ready to move next month.",
    "Ready to sell, when can you list it?",
  ],
  call_request: [
    "Please call me after 5.",
    "Give me a call tomorrow.",
    "What time can we talk?",
    "My number is 555 0100.",
    "Phone me when you can.",
  ],
  financing: [
    "We're pre-approved for up to 500k.",
    "Our mortgage is approved.",
    "Financing is in place.",
    "We'd be paying cash.",
  ],
  availability: [
    "Is it still available?",
    "Is the house still for sale?",
    "Still on the market?",
  ],
  price: [
    "What's the price?",
    "Is the price negotiable?",
    "How much are they asking?",
  ],
};

test("reason codes are the documented set", () => {
  assert.deepEqual([...HOT_REASONS].sort(), ["availability", "call_request", "financing", "offer", "price", "ready", "viewing"]);
});

for (const [reason, phrases] of Object.entries(HOT)) {
  for (const p of phrases) {
    test(`hot (${reason}): "${p}"`, () => {
      assert.equal(hotReplyReason(SUBJECT, p), reason, "plain");
      assert.equal(hotReplyReason(SUBJECT, p.toUpperCase()), reason, "upper case");
      assert.equal(hotReplyReason(SUBJECT, `Hi,\n\n${p}\n\nThanks,\nPat${QUOTED}`), reason, "with greeting, sign-off and quoted history");
    });
  }
}

test("the strongest reason wins when several appear", () => {
  assert.equal(hotReplyReason(SUBJECT, "Is the price negotiable? We're ready to make an offer."), "offer");
  assert.equal(hotReplyReason(SUBJECT, "Call me, I'm pre-approved."), "financing");
  assert.equal(hotReplyReason(SUBJECT, "Is it still available? Can we see the house?"), "viewing");
});

const NOT_HOT = [
  "Not interested, thanks.",
  "No longer interested — we bought elsewhere.",
  "I'm not really looking right now.",
  "Please don't call me.",
  "Don’t call, just email.",
  "We already bought a house, thanks.",
  "Already sold it privately.",
  "Stop emailing me.",
  "stop",
  "Unsubscribe me please, I don't want a viewing.",
  "Remove me from your list.",
  "No thanks.",
  "No, thank you. Not ready to buy yet.",
  "Not at this time, maybe next year. What's the price though?",
  "We changed our mind about selling.",
  "Wrong person, I never asked about a viewing.",
  "Thanks for the update!",
  "Sounds good.",
  "Who is this?",
  "",
];

for (const p of NOT_HOT) {
  test(`not hot: "${p}"`, () => {
    assert.equal(hotReplyReason(SUBJECT, p), null);
    assert.equal(hotReplyReason(SUBJECT, `${p}${QUOTED}`), null, "quoted hot words do not count");
  });
}

test("opt-out replies are never hot", () => {
  for (const p of ["unsubscribe", "STOP", "remove me", "opt out"]) {
    assert.equal(hotReplyReason(SUBJECT, p), null, p);
  }
  assert.equal(hotReplyReason("Re: UNSUBSCRIBE", "Can we book a viewing?"), null, "opt-out in the subject");
});

test("only the person's own text counts: quoted history, signatures and the subject are ignored", () => {
  assert.equal(hotReplyReason(SUBJECT, `Thanks!${QUOTED}`), null);
  assert.equal(hotReplyReason(SUBJECT, "> Can we book a viewing?\n> Is it still available?"), null, "only quoted lines");
  assert.equal(hotReplyReason(SUBJECT, "Thanks!\n-- \nPat — call me on 555 0100 for a viewing"), null, "signature");
  assert.equal(hotReplyReason(SUBJECT, "Thanks!\nSent from my iPhone\nCall me"), null, "phone footer");
  assert.equal(hotReplyReason(SUBJECT, "Thanks!\n\n-----Original Message-----\nFrom: Agent\nCan we see the house?"), null, "Outlook block");
  assert.equal(hotReplyReason("Re: Book a viewing", "Thanks!"), null, "subject ignored");
  assert.equal(hotReplyReason(SUBJECT, "Thanks!\nOn Mon, Sep 28, 2026 Agent Smith\nwrote:\n> call me"), null, "wrapped quote header");
});

test("HTML-only replies are read the same way (quoted blocks removed)", () => {
  assert.equal(hotReplyReason(SUBJECT, "", "<p>Can we book a <b>viewing</b>?</p><blockquote>not interested</blockquote>"), "viewing");
  assert.equal(hotReplyReason(SUBJECT, null, "<div>Thanks</div><blockquote>Call me about a viewing</blockquote>"), null);
});

test("ownReplyText keeps every line the person wrote and nothing after the quote header", () => {
  assert.equal(ownReplyText(`Hi\n\nLine two\n> quoted\nLine three${QUOTED}`), "Hi\nLine two\nLine three");
  assert.equal(ownReplyText("x".repeat(30_000)).length, 5_000);
});

test("non-string input is handled", () => {
  assert.equal(hotReplyReason(null, null, null), null);
  assert.equal(hotReplyReason(undefined, 42, {}), null);
});
