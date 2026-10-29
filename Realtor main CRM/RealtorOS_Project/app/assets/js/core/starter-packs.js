/* ============================================================
   starter-packs.js — the ready-made sequences, in one registry.

   Five packs, each a template plus a rule plus its steps, created as
   DRAFTS and never activated. The agent reads the wording, makes it sound
   like themselves, and switches it on when they are ready.

   ONE REGISTRY, because two callers need it: the Automation page's "Add
   starter pack" button and step 3 of the onboarding wizard. Two copies of
   this copy would drift, and the wording is the product here - a sequence
   an agent is embarrassed to send is worse than no sequence.

   WHY THE COPY IS PLAIN. It is a starting point to edit, not a finished
   campaign. Overwrought marketing language is harder to cut back than to
   add, and an agent who has to rewrite everything will just not use it.

   IDEMPOTENT BY NAME. Anything already there is left exactly as it is,
   edits included, so installing twice adds nothing and changes nothing.
   ============================================================ */
window.App = window.App || {};

App.starterPacks = (function () {
  "use strict";

  const S = () => App.store;

  const DAY = 24 * 60;   // minutes

  /** The workspace's own won stage, for the post-closing pack. */
  function wonStageName() {
    const settings = (S().getState() && S().getState().settings) || {};
    const stages = Array.isArray(settings.pipelineStages) ? settings.pipelineStages : [];
    const won = stages.find((st) => st && st.terminal === "won");
    return (won && won.name) ? won.name : null;
  }

  /**
   * Every pack. `id` is stable and is what a caller ticks; `name` is what
   * the agent sees and what idempotence is keyed on.
   *
   * `requires` names something the workspace must have for the pack to make
   * sense. A pack whose requirement is missing is skipped with a reason
   * rather than created pointing at nothing.
   */
  function all() {
    const won = wonStageName();
    return [
      {
        id: "buyer",
        name: "New buyer lead",
        blurb: "Welcomes a new buyer, then nudges you to call and check in.",
        rule: {
          name: "New buyer lead",
          triggerType: "contact_created",
          triggerConfig: {},
          // Phase 2F: it can finally say what it means. The contact's own
          // type is what the Add Contact form already asked for, so there
          // is nothing for the agent to tag by hand.
          audienceFilter: { type_in: ["Buyer"] }
        },
        template: {
          name: "New buyer lead — welcome",
          subject: "Good to meet you, {{first_name}}",
          bodyText: "Hi {{first_name}},\n\n"
            + "Thanks for getting in touch. I help buyers find the right place without "
            + "the usual runaround, and I would rather understand what you are after "
            + "before sending you listings.\n\n"
            + "What matters most to you - the area, the budget, the timing?\n\n"
            + "Speak soon,\n{{agent_name}}"
        },
        steps: [
          { actionType: "send_email", delayMinutes: 0 },
          { actionType: "wait", delayMinutes: 2 * DAY },
          { actionType: "create_task", delayMinutes: 0,
            config: { title: "Call", priority: "High" } },
          { actionType: "wait", delayMinutes: 3 * DAY },
          { actionType: "send_email", delayMinutes: 0 },
          { actionType: "wait", delayMinutes: 5 * DAY },
          { actionType: "create_task", delayMinutes: 0,
            config: { title: "Check in", priority: "Medium" } }
        ]
      },
      {
        id: "seller",
        name: "New seller lead",
        blurb: "Welcomes a new seller, then nudges you to call and check in.",
        rule: {
          name: "New seller lead",
          triggerType: "contact_created",
          triggerConfig: {},
          audienceFilter: { type_in: ["Seller"] }
        },
        template: {
          name: "New seller lead — welcome",
          subject: "About selling, {{first_name}}",
          bodyText: "Hi {{first_name}},\n\n"
            + "Thanks for reaching out about selling. Before talking about price, it "
            + "helps to know what you are hoping for - a quick sale, the best number, "
            + "or fitting around a move.\n\n"
            + "Tell me which, and I will tell you honestly what I think is realistic.\n\n"
            + "Speak soon,\n{{agent_name}}"
        },
        steps: [
          { actionType: "send_email", delayMinutes: 0 },
          { actionType: "wait", delayMinutes: 2 * DAY },
          { actionType: "create_task", delayMinutes: 0,
            config: { title: "Call", priority: "High" } },
          { actionType: "wait", delayMinutes: 3 * DAY },
          { actionType: "send_email", delayMinutes: 0 },
          { actionType: "wait", delayMinutes: 5 * DAY },
          { actionType: "create_task", delayMinutes: 0,
            config: { title: "Check in", priority: "Medium" } }
        ]
      },
      {
        id: "revival",
        name: "Cold lead revival",
        blurb: "Reaches out once to a contact marked Cold after two months of silence.",
        rule: {
          name: "Cold lead revival",
          triggerType: "no_contact",
          triggerConfig: { days: 60, fire_hour: 9 },
          // Phase 2F: a cold lead is one marked Cold, which is a field the
          // contact already has.
          audienceFilter: { temperature_in: ["Cold"] }
        },
        template: {
          name: "Cold lead revival",
          subject: "Still looking, {{first_name}}?",
          bodyText: "Hi {{first_name}},\n\n"
            + "It has been a couple of months, so I thought I would check rather than "
            + "assume. Are you still looking, or has it gone on the back burner?\n\n"
            + "Either answer is useful - if it is the second, I will stop filling your "
            + "inbox.\n\n"
            + "Best,\n{{agent_name}}"
        },
        steps: [
          { actionType: "send_email", delayMinutes: 0 },
          { actionType: "wait", delayMinutes: 2 * DAY },
          { actionType: "create_task", delayMinutes: 0,
            config: { title: "Decide whether to keep following up", priority: "Low" } }
        ]
      },
      {
        id: "openhouse",
        name: "Open-house visitor",
        blurb: "Thanks somebody who came to a viewing, then reminds you to follow up.",
        rule: {
          name: "Open-house visitor",
          triggerType: "contact_created",
          triggerConfig: {},
          // This one CAN say what it means: the tag is how an open-house
          // visitor is recorded in the first place.
          audienceFilter: { tags_any: ["Open house"] }
        },
        template: {
          name: "Open-house visitor — thank you",
          subject: "Thanks for coming by, {{first_name}}",
          bodyText: "Hi {{first_name}},\n\n"
            + "Thanks for coming to see the place. What did you make of it?\n\n"
            + "If it was not quite right, tell me what was off and I will keep an eye "
            + "out for something closer.\n\n"
            + "Best,\n{{agent_name}}"
        },
        steps: [
          { actionType: "send_email", delayMinutes: 0 },
          { actionType: "wait", delayMinutes: 2 * DAY },
          { actionType: "create_task", delayMinutes: 0,
            config: { title: "Follow up on the viewing", priority: "Medium" } }
        ]
      },
      {
        id: "pastclient",
        name: "Past clients & sphere",
        blurb: "Birthday and home-anniversary greetings, a post-closing check-in, and a quarterly hello.",
        // The only multi-rule pack: these four belong together and an agent
        // thinks of them as one decision.
        rules: [
          {
            rule: { name: "Birthday greeting", triggerType: "birthday",
                    triggerConfig: { days_before: 0, fire_hour: 9 }, audienceFilter: {} },
            template: {
              name: "Birthday greeting",
              subject: "Happy birthday, {{first_name}}!",
              bodyText: "Hi {{first_name}},\n\n"
                + "Just a quick note to wish you a very happy birthday. I hope you get "
                + "to spend it doing something you enjoy.\n\n"
                + "All the best,\n{{agent_name}}"
            },
            steps: [{ actionType: "send_email", delayMinutes: 0 }]
          },
          {
            rule: { name: "Home anniversary", triggerType: "home_anniversary",
                    triggerConfig: { days_before: 0, fire_hour: 9 }, audienceFilter: {} },
            template: {
              name: "Home anniversary",
              subject: "Happy anniversary in your home, {{first_name}}",
              bodyText: "Hi {{first_name}},\n\n"
                + "It is another year since you got the keys. I hope the place still "
                + "feels like the right one.\n\n"
                + "If you ever want to know what it might be worth now, just ask - no "
                + "pressure either way.\n\n"
                + "Warm wishes,\n{{agent_name}}"
            },
            steps: [{ actionType: "send_email", delayMinutes: 0 }]
          },
          {
            rule: { name: "30 days after closing", triggerType: "deal_stage_changed",
                    triggerConfig: won ? { to_stage: won } : null, audienceFilter: {} },
            requires: won ? null : "no closing stage set up in this workspace",
            template: {
              name: "30 days after closing",
              subject: "How is the new place, {{first_name}}?",
              bodyText: "Hi {{first_name}},\n\n"
                + "It has been about a month. How are you settling in?\n\n"
                + "If anything still needs sorting out, I am happy to point you at "
                + "someone good. And if you know anybody else thinking about moving, I "
                + "would be glad to help them the same way I helped you.\n\n"
                + "Thanks again,\n{{agent_name}}"
            },
            steps: [
              { actionType: "wait", delayMinutes: 30 * DAY },
              { actionType: "send_email", delayMinutes: 0 },
              { actionType: "create_task", delayMinutes: 0,
                config: { title: "Ask for a referral", priority: "Medium" } }
            ]
          },
          {
            rule: { name: "Stay in touch", triggerType: "no_contact",
                    triggerConfig: { days: 90, fire_hour: 9 },
                    // Phase 2E: the tag IS the audience now.
                    audienceFilter: { tags_any: ["Past client"] } },
            template: {
              name: "Stay in touch",
              subject: "Thinking of you, {{first_name}}",
              bodyText: "Hi {{first_name}},\n\n"
                + "It has been a while, and I did not want another few months to go by "
                + "without saying hello.\n\n"
                + "No agenda - just let me know if there is ever anything I can help "
                + "with.\n\n"
                + "Best,\n{{agent_name}}"
            },
            steps: [{ actionType: "send_email", delayMinutes: 0 }]
          }
        ]
      }
    ];
  }

  /** Flattens a pack into the individual rules it installs. */
  function itemsOf(pack) {
    return Array.isArray(pack.rules)
      ? pack.rules
      : [{ rule: pack.rule, template: pack.template, steps: pack.steps, requires: pack.requires }];
  }

  /** Two audiences mean the same thing, whatever order the keys arrived in. */
  function sameAudience(a, b) {
    const norm = (f) => {
      const out = {};
      Object.keys(f || {}).sort().forEach((k) => {
        const v = f[k];
        out[k] = Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).sort() : v;
      });
      return JSON.stringify(out);
    };
    return norm(a) === norm(b);
  }

  /**
   * Phase 2F. A draft this pack created, which the agent has not touched
   * since, and whose audience the pack now knows how to express properly.
   *
   * ALL THREE conditions, because the rule belongs to the agent the moment
   * they edit it. "Unchanged" is updated_at still sitting on created_at -
   * the row is written once at creation and every later write moves it -
   * with a couple of seconds of slack for the clock skew between the
   * INSERT and its own trigger. An active, paused or edited rule is left
   * exactly as it is and reported as already there, like any other.
   */
  function upgradableAudience(existing, item, packId) {
    if (!existing || existing.status !== "draft") return null;
    const meta = existing.metadata || {};
    if (meta.starter_pack !== packId) return null;
    const created = Date.parse(existing.created_at);
    const updated = Date.parse(existing.updated_at);
    if (!Number.isFinite(created) || !Number.isFinite(updated)) return null;
    if (Math.abs(updated - created) > 2000) return null;
    const wanted = item.rule.audienceFilter || {};
    if (sameAudience(existing.audience_filter || {}, wanted)) return null;
    return wanted;
  }

  /**
   * Installs the named packs. Returns what happened, for the caller to put
   * into words - it deliberately does not toast, because the wizard and the
   * Automation page say it differently.
   *
   * { created: [names], updated: [names], skipped: [{name, reason}],
   *   failed: [{name, error}] }
   */
  async function install(packIds, opts) {
    opts = opts || {};
    const wanted = Array.isArray(packIds) ? packIds : [packIds];
    const packs = all().filter((p) => wanted.indexOf(p.id) >= 0);

    const created = [];
    const updated = [];
    const skipped = [];
    const failed = [];

    // Read what exists ONCE, so the whole run is decided against one
    // consistent picture.
    let templates = [];
    try { templates = await S().messageTemplates.list({ orderBy: "name" }); }
    catch (err) { templates = []; }
    let rules = [];
    try { rules = await S().automationRules.list(); }
    catch (err) { rules = []; }

    const templateByName = {};
    (templates || []).forEach((t) => { if (t && t.name) templateByName[t.name] = t; });
    const ruleByName = {};
    (rules || []).forEach((r) => { if (r && r.name) ruleByName[r.name] = r; });

    for (const pack of packs) {
      for (const item of itemsOf(pack)) {
        const name = item.rule.name;
        if (item.requires || item.rule.triggerConfig === null) {
          skipped.push({ name, reason: item.requires || "this workspace is missing something it needs" });
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(ruleByName, name)) {
          // Phase 2F: three of the packs used to install an audience they
          // could not express. An untouched draft they created themselves
          // is theirs to correct; anything else is the agent's.
          const existing = ruleByName[name];
          const wanted = upgradableAudience(existing, item, pack.id);
          if (!wanted) { skipped.push({ name, reason: "already there" }); continue; }
          try {
            await S().automationRules.update(existing.id, { audienceFilter: wanted });
            ruleByName[name] = Object.assign({}, existing, { audience_filter: wanted });
            updated.push(name);
          } catch (err) {
            failed.push({ name, error: (err && err.message) || "unknown error" });
          }
          continue;
        }
        try {
          // The template first: a Send Email step cannot exist without one.
          // An existing template of the same name is reused, not duplicated.
          const template = Object.prototype.hasOwnProperty.call(templateByName, item.template.name)
            ? templateByName[item.template.name]
            : await S().messageTemplates.create(Object.assign({}, item.template, { isActive: true }));
          templateByName[item.template.name] = template;

          const rule = await S().automationRules.create(Object.assign({}, item.rule, {
            timezone: opts.timezone || "UTC",
            metadata: { starter_pack: pack.id }
          }));
          ruleByName[name] = rule;

          let order = 1;
          for (const step of item.steps) {
            await S().automationSteps.create(rule.id, Object.assign({}, step, {
              stepOrder: order++,
              templateId: step.actionType === "send_email" ? template.id : undefined
            }));
          }
          created.push(name);
        } catch (err) {
          failed.push({ name, error: (err && err.message) || "unknown error" });
        }
      }
    }
    return { created, updated, skipped, failed };
  }

  /** One honest sentence about what install() did. */
  function summarize(result) {
    const parts = [];
    const upgraded = result.updated || [];
    if (result.created.length) {
      parts.push("Added " + result.created.length + " draft"
        + (result.created.length === 1 ? "" : "s") + ".");
    }
    if (upgraded.length) {
      parts.push("Narrowed the audience on " + upgraded.join(", ")
        + " (still " + (upgraded.length === 1 ? "a draft" : "drafts") + ", and untouched).");
    }
    const already = result.skipped.filter((s) => s.reason === "already there");
    const blocked = result.skipped.filter((s) => s.reason !== "already there");
    if (already.length) parts.push("Already there: " + already.map((s) => s.name).join(", ") + ".");
    blocked.forEach((s) => {
      parts.push("Skipped " + s.name + " (" + s.reason + ").");
    });
    if (result.failed.length) {
      parts.push("Could not add: "
        + result.failed.map((f) => f.name + ": " + f.error).join("; ") + ".");
    }
    if (!parts.length) parts.push("Nothing to add.");
    return parts.join(" ");
  }

  return { all, itemsOf, install, summarize, wonStageName };
})();
