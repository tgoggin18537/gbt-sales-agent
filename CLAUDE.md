# gbt-sales-agent-main — Spiffy SMS bot for SpringBreak U / GoBlueTours

## What this is

A voice-matched AI SMS sales bot for Spiffy at GoBlueTours / SpringBreak U. $1,500 contract. V1 approved by Spiffy on April 16 call. V2 blocked pending his answers to the V2 questions doc.

Spiffy sells spring break trip packages to college students. The bot handles inbound SMS leads and books deposits. Voice match is critical, this is a casual college-bro vibe (lower case, contractions, "bet", "word", "fr", emoji budget).

## Stack

Same as llmd-closebot V2 architecture (this was built from the LLMD playbook):

- Cloudflare Workers
- Durable Objects (per-contact state)
- D1 (analytics)
- KV (idempotency)
- Anthropic Claude (Sonnet for replies, Haiku for classifiers)
- GoHighLevel (SMS + CRM)

## Architecture

```
Inbound SMS (GHL webhook)
  → Cloudflare Worker
  → [idempotency KV] [shutoff tag check] [manual-outbound check] [existing-customer check]
  → Durable Object (per-contact state, qualifiers, link send count)
  → Claude Sonnet (writer brain) with two-brain pattern
  → Guardrail (rule enforcer: dashes, emoji budget, rhetorical-aware compound check, qualifier-repeat guard)
  → retry loop (up to 3 attempts)
  → safe fallback SMS if still failing
  → GHL sendSms
  → persist turn to DO + D1 analytics
```

## Key files

- `BUILD_PLAYBOOK.md` — playbook adapted from LLMD, has voice rules and failure patterns
- `SPIFFY_BOT_OVERVIEW.md` — customer-facing overview doc Spiffy was shown on the V1 call
- `SPIFFY_V2_QUESTIONS.md` — questions Spiffy needs to answer for V2 (deposit amounts, 21+ rules, payment deadlines, pricing, flights, insurance, excursions)
- `PHASE_5_MOCK_CONVERSATIONS.md` — 15 mock conversations regenerated against the live deployed bot
- `worker/src/prompts/spiffy.ts` — THE prompt
- `worker/src/agents/guardrail.ts` — regex enforcer with custom Spiffy rules (qualifier repeat, soft-turn detection, apostrophe density, length variance)
- `worker/src/routes/webhook.ts` — production handler
- `worker/src/routes/simulate.ts` — `/debug/simulate` endpoint (no auth, for live demo)
- `worker/src/evals/` — gates 1/2/3 (guardrail tests, audit-content, eval harness)

## Deployed worker

`https://gbt-spiffy.limitless-living-bot.workers.dev`

Endpoints:
- `GET /health` — liveness
- `POST /webhook/ghl/inbound-sms` — GHL inbound (auth via `GHL_WEBHOOK_SECRET` header)
- `POST /debug/simulate` — debug, no auth, accepts `{inbound, state}` and returns the bot's reply

## Live demo helper

```bash
spiffy() {
  curl -s -X POST https://gbt-spiffy.limitless-living-bot.workers.dev/debug/simulate \
    -H 'Content-Type: application/json' \
    -d "{\"inbound\":\"$1\",\"state\":{\"openerSent\":true}}" | python3 -c "import sys,json; print(json.load(sys.stdin)['reply'])"
}
```

Then `spiffy "yo whats up"` in any terminal.

## Pending V2 work

- ✅ Spiffy V2 answers arrived 2026-04-25 (see `docs/spiffy-v2-spec.md`). 9 hotels across 5 destinations, full pricing model, banned phrases, follow-up cadence in his voice.
- ⏳ Remaining $500 in Upwork escrow still owed
- ⏳ Update prompt + FAQ + KB + guardrail with V2 spec content (see `docs/spiffy-v2-spec.md`)
- ⏳ Wire production GHL workflows (3 secrets needed: `GHL_API_KEY`, `GHL_LOCATION_ID`, `GHL_WEBHOOK_SECRET`)
- ⏳ Port today's LLMD V3 architectural fixes (per-contact mutex, synthetic messageId fallback, broadened apology+replay regex, retry-after cap). See "lessons learned" section below.

## Critical things to know

- Voice judge here is different from LLMD. Spiffy's voice is much more casual, drops apostrophes 40% of the time, breaks grammar on purpose. The guardrail has an apostrophe density check (rejects if >60% have apostrophes).
- Soft-turn detection prevents the bot from tacking a qualifier onto every reply. "cool thanks" → just "bet", not "bet, which week is your spring break?"
- Qualifier repeat guard rejects asking the same family of question 3+ times in one conversation (week, destination, group size, school, timeline).
- Rhetorical-aware compound check: only counts answer-seeking `?`, not rhetorical ones. Allows "honest take? Punta Cana" through.
- "Finesse" timing guard: bot only uses urgency/incentive language after lead has signaled deposit-ready intent.

## Lessons learned from LLMD V3 (2026-04-25)

LLMD shipped V3 today with three architectural fixes that ALL voice-matched SMS bots should have. Port these into Spiffy before V2 features:

1. **Per-contact mutex on the DO.** `inFlight`, `inFlightSince`, `pendingMessages`, `recentInboundIds` (cap 20). New `/claim`, `/release`, `/reset` endpoints. Stale-lock recovery at 60s. Prevents rapid-fire double-fires and lost context. Reference: `~/code/llmd-closebot/worker/src/memory/ContactThread.ts`.

2. **Synthetic messageId fallback in webhook.** GHL doesn't reliably expose `{{message.id}}` in workflows. Without this, `messageId: null` causes silent dedup lockouts. Solution: `resolveInboundMessageId` helper that tries known fields first, falls back to `sha256(contactId + body + minute-bucket)`. Two-layer dedup (KV idempotency + DO ring buffer) with `idValid` guards everywhere. Reference: `~/code/llmd-closebot/worker/src/routes/webhook.ts`.

3. **Anthropic retry-after cap at 30s.** `Math.min(retryAfterRaw, 30)`. Without this, the API can return retry-after of 240s, the bot hangs for 4 minutes, and the lead thinks the bot is dead. Reference: `~/code/llmd-closebot/worker/src/integrations/anthropic.ts`.

4. **Broadened apology+replay regex.** The narrow regex from V1/V2 only catches one variant. The model improvises new ones ("Ha sorry, my last message got scrambled"). Broader patterns required: `/\bsorry,?\s+(?:about that|something|my last|that got)/i`, `/\b(my last message|what i said|let me try (that|again)|to recap what i said)\b/i`, `/\b(scrambled|glitched|got messed up|got cut off on my end|something went wrong on my end)\b/i`. Plus TOP HARD RULES in the prompt forbidding apology+replay AND forcing rapid-fire to address the most recent SUBSTANTIVE message.

## Five non-negotiables for any session in this repo

1. **One Claude session per branch.** No parallel sessions on the production branch. If experimental, use a separate branch in a worktree. (Tonight's merge hell on LLMD came from violating this. Then the same pattern showed up on Spiffy: this folder existed twice, once in git and once as a downloaded zip with diverged content.)

2. **Architecture port before V2 features.** Port the four LLMD V3 fixes above before any V2 prompt or content work. Smoke test the architecture port standalone. Only then start V2.

3. **When the bot misbehaves, diagnose layer FIRST.** Architecture vs prompt vs integration. Don't reflexively edit the prompt. Check the logs, identify the layer, fix at the right layer.

4. **Test sequence defined BEFORE deploy.** Every deploy gets smoke tested on Thomas's number with this exact sequence (adapt to spring break sales): cold opener trigger → product question (no catalog dump) → rapid-fire double-text (one reply, no apology) → qualification (USA, dates, group size, hotel pref) → contact info capture → booking link delivery + soft close. Rollback target ID always known before deploying.

5. **Voice match is the only metric.** Spiffy's voice in `docs/sakari-all-booked.csv` and `docs/Copy of Sakari Convos*` is the source of truth. Every prompt rule, FAQ entry, guardrail check serves voice match.

## Anti-patterns (things that wasted time on LLMD)

- Editing the prompt to "fix" rapid-fire bugs (they were architecture)
- Running evals before architecture is solid (you measure noise, $20 wasted on LLMD)
- Letting the bot volunteer specific product names (catalog-dump). For Spiffy, this means hotels, party events, peptide-style "Option B" naming applies.
- Two parallel Claude sessions on the same branch (caused tonight's merge hell on LLMD)
- Banned-phrase regex too narrow (model improvises variants the regex misses)
- Not capping Anthropic retry-after (240s = bot hangs for 4 minutes)
- Storing raw GHL `messageId` without nullability check (causes silent dedup lockouts)
- Downloading Claude.ai web session zips and never committing them (caused this folder + spiffy-closebot to diverge)

## Order of operations for V2

1. Port architecture fixes from llmd-closebot (the four items above)
2. Deploy and smoke test architecture port (no prompt changes yet)
3. Update voice rules in prompt + guardrail based on `docs/spiffy-v2-spec.md` and Sakari CSVs
4. Update FAQ and KB with V2 hotel info, pricing model, party passes, free trip program
5. Add pricing communication rules as TOP HARD RULES (never lead with pricing, first quote by email, etc., per V2 spec section 2)
6. Add Spiffy's banned phrases to guardrail (V2 spec section 4)
7. Port Spiffy's follow-up cadence verbatim to `prompts/followups.ts` (V2 spec section 6)
8. Build/extend golden eval cases covering: hotel comparison, pricing ask, group leader, late booking, payment plan, alternative destination, flights, excursions
9. Iterate prompt against evals until voice match is high
10. Smoke test the test sequence on Thomas's number
11. Ship to one tagged contact (Thomas) for live monitoring 24h
12. Roll out to wider audience if monitoring is clean

## Voice rules for Thomas himself when drafting in this repo

Standard global rules apply (no em dashes, conversational, no "I'd be happy to" / "feel free to"). See `~/.claude/CLAUDE.md` for the full set.
