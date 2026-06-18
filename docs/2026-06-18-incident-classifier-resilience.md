# Incident + fixes: 2026-06-16 to 06-18 (classifier shutoff, resilience, extraction)

Prod after: `a0473fae-339b-4801-ae83-14fa29ee6fbb`. Full narrative in the Obsidian
client note (`02-clients/spiffy-gobluetours.md`). This is the code-side reference.

## Symptom
Bot replied fine to the 1st lead message, then tagged `human-takeover` +
`workflow-race-detected` on the 2nd, every time. Trigger: a back-to-back
double-text.

## Root causes (stacked)
1. **Classifier false positive.** `classifyConversationContext` treated GHL CRM
   activity rows ("Opportunity created/updated", `messageType=TYPE_ACTIVITY_*`,
   `direction=outbound`) AND pre-bot workflow opener texts as a human takeover.
2. **ContactThread `/append` crash** on state-only appends (`body.message`
   undefined → `.role` threw → 500 → GHL retry loop, looked like a hang).
3. **Anthropic account at $0** (account-level credit) → every `callClaude` 500'd
   → GHL retry storm. Resolved by switching the prod `ANTHROPIC_API_KEY` secret
   to Spiffy's funded key.
4. **Multi-fact-dump miss** → bot re-asked a given field + emitted a visible
   self-correction tell.

## Verified GHL field semantics (pulled from live API — trust these)
- `messageType`: `TYPE_SMS` (real text) | `TYPE_EMAIL` (workflow breakdown) |
  `TYPE_ACTIVITY_*` (CRM noise, NOT a message).
- `source`: `workflow` (automation) | `app` (bot OR human inbox) | undefined (inbound).

## Fixes (file → what)
- `integrations/ghl.ts` `classifyConversationContext` — source-driven, 4 states
  (fresh/clean/workflow_catchup/manual_takeover). A real takeover = outbound
  `TYPE_SMS`, `source!=='workflow'`, not bot's id, dateAdded > bot's last send.
  Dropped the time-based `workflow_race` + its tag. Tests: `ghl.test.ts` (13).
- `integrations/ghl.ts` — 8s `AbortSignal.timeout` on every GHL fetch;
  `getRecentMessages` returns `[]` on any error; `getRecentMessages` now returns
  `messageType`.
- `memory/ContactThread.ts` — `/append` accepts state-only (no `message`); added
  sticky `week/destination/groupSize/school` qualifier fields.
- `agents/classifier.ts` `extractQualifiers` — deterministic capture (closed-set
  destination, group-size-with-context-word, week patterns, known-school). Tests:
  `extractQualifiers.test.ts` (14). Captures nothing when 2+ destinations named.
- `routes/webhook.ts` — extracts qualifiers per inbound → persists → feeds turn
  context; `callClaude` wrapped → silent human-handoff + 200 on API failure;
  synthetic dedup id seed dropped the minute-bucket (was double-firing on
  retries across a minute boundary).
- `index.ts` — webhook route swallows any unexpected throw to **200** (kills GHL
  retry storms); new `GET /debug/classify?contactId=X` non-destructive probe.
- `routes/simulate.ts` — mirrors webhook extraction (faithful test harness).
- `prompts/spiffy.ts` — week=enough (school sets dates, don't ask lead to pick);
  count-agnostic destination ack; stronger "ALREADY CAPTURED" turn-context line.
- `agents/guardrail.ts` — reject self-correction tells; rewrite multi-dest "both"→"all".

## How to debug the next one (don't repeat the mistakes)
- `GET /debug/classify?contactId=X` with `x-ghl-webhook-secret` header → see the
  real classifier decision against live state, no SMS.
- The real webhook secret is the GHL custom value `ghl_webhook_secret` (local
  `.dev.vars` may be stale).
- A webhook 500 = GHL retry storm, NOT a hang. Check the downstream error.
- Anthropic credits are account-level. `$` by a key = spend, not balance.
- Deploy: `npx wrangler deploy` (NO `--env`). Key swap: `npx wrangler secret put ANTHROPIC_API_KEY`.

## Still open (not blocking)
- Classifier GHL-call amplification at burst (cache the pre-send recheck).
- `MiaState.messages` grows unbounded (cap ~40).
