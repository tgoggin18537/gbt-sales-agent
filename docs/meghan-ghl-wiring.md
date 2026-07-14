# Meghan Bot — GHL Wiring Guide (verified)

Click-by-click to put Meghan live in the **same GBT/SpringBreak U subaccount**
as Spiffy, on her **own phone line**. Written 2026-07-13, verified against:
the deployed worker code (`worker/src/routes/webhook.ts`, `integrations/ghl.ts`),
the live Spiffy tag behavior (`docs/tag-cadence.md`), the proven workflow
pattern (`docs/ghl-workflow-spec.md`), and the GHL Conversations API docs
(number-selection behavior confirmed below).

---

## The one-line recommendation: CLONE, don't rebuild

Meghan lives in the **same subaccount** as Spiffy. Spiffy's workflows already
work (fixed + verified live on July 8). So the safest, fastest path is:

> In GHL, **clone each Spiffy workflow**, rename `Spiffy` → `Meghan`, and change
> only TWO things per workflow: (1) the **trigger gate** so it fires on
> Meghan's leads/line, not Spiffy's; (2) the **webhook URL** to the Meghan
> worker. Everything else — the secret custom value, shutoff tags, the 30s
> dedup wait, the body shape — is already proven and should be left identical.

Building from scratch reintroduces every bug we already fixed. Clone.

---

## Architecture: two personas, one subaccount, two lines

| | Spiffy | Meghan |
|---|---|---|
| Worker | `gbt-spiffy.gobluetours.workers.dev` | `gbt-meghan.gobluetours.workers.dev` |
| Webhook | `…/webhook/ghl/inbound-sms` | `…/webhook/ghl/inbound-sms` (same path) |
| Phone line | his number | **her number** (Derrick to provision) |
| Secret | `x-ghl-webhook-secret` custom value | **same custom value** (same subaccount) |
| GHL creds | same subaccount | **same** (worker secrets already set) |

Derrick confirmed (Jul 10): same subaccount, each rep has their own line, both
take leads from both brands, assignment is school-based upstream. So the ONLY
thing that separates the two bots at the GHL layer is **which line/leads each
workflow is gated to.** Get that gate right and two bots can never answer the
same lead.

---

## The opener is owned by the WORKER — identical to Spiffy (verified 2026-07-14)

Confirmed from Spiffy's live "Send Initial Message" action: his opener is sent by
the WORKER via a `__INITIAL_TOUCH__` webhook, NOT hardcoded in GHL. Meghan mirrors
this exactly. The worker sends her opener AND records `openerSent=true`, so when
the lead replies it answers instead of re-greeting. (An earlier attempt hardcoded
her opener in GHL — that diverged from Spiffy and caused a double-opener. Reverted;
the `EXTERNAL_OPENER` secret was deleted 2026-07-14.)

Rule: Meghan's first-touch workflow is a CLONE of Spiffy's — a single
`__INITIAL_TOUCH__` Custom Webhook, no hardcoded opener/intro SMS. Do NOT put a
message containing her name + brand ("Meghan … Go Blue Tours") in a hardcoded step
BEFORE the webhook — the worker treats that as "already opened" and skips its
opener.

## CRITICAL: making Meghan send from HER line (do not skip)

GHL picks the outbound number like this (confirmed via API docs):
- **Existing conversation** → uses the **last-used number** on that thread.
- **No conversation yet** → falls back to the **location default number**.

Consequences in a two-line subaccount:
- **Inbound replies are automatically correct.** The lead texted Meghan's line,
  so the thread is on her number, and every bot reply inherits it. No config.
- **The bot-initiated opener is the risk.** If the bot's opener is the first
  message on the thread, GHL uses the *default* number — which could be
  Spiffy's line.

Two defenses, use BOTH:
1. **GHL side (primary):** Meghan's First-Touch workflow sends its automated
   intro ("…your personal trip rep Meghan will text shortly") **from Meghan's
   number** (set the Send-SMS step's From number, or run the workflow as
   Meghan). That establishes the thread on her line before the bot ever
   speaks, so the bot's opener inherits her number.
2. **Worker side (defense-in-depth, already coded):** set the worker secret
   `SENDER_PHONE` to Meghan's line and the worker pins `fromNumber` on every
   send. Do this the moment her number is provisioned:
   ```
   cd worker
   echo "+1XXXXXXXXXX" | CLOUDFLARE_ACCOUNT_ID=48ed5f8777d0983ff1cef054fde51b35 \
     npx wrangler secret put SENDER_PHONE -c wrangler.meghan.toml
   ```
   REQUIRED before real leads: the worker sends the opener, and with no thread
   yet GHL uses the DEFAULT number. If that is Spiffy's line, her opener goes out
   from HIS number and the lead's reply lands on HIS bot. `SENDER_PHONE` pins her
   line and prevents this. (For testing with your own phone it's harmless.)

Verify at first test: a bot reply shows **Meghan's number** as the sender in
the GHL conversation, not Spiffy's.

---

## Shared settings

- **Webhook URL:** `https://gbt-meghan.gobluetours.workers.dev/webhook/ghl/inbound-sms`
  (FULL path — `/webhook` alone 404s. This exact bug cost us an hour on July 8.)
- **Header:** `x-ghl-webhook-secret: {{ custom_values.x_ghl_webhook_secret }}`
  — do NOT type the value. Copy the merge field from Spiffy's working
  "Wake Up Spiffy" webhook action; it's the same custom value in this
  subaccount. (The worker secret `GHL_WEBHOOK_SECRET` on gbt-meghan already
  matches this custom value — set July 13.)
- **Method:** `POST` · **Content-Type:** `application/json`
- **Shutoff tags (LIVE Spiffy list — use identically):**
  `do-not-message`, `human-takeover`, `call-booked`, `customer`, `booked`, `traveler`
  Clean kill switch = **`human-takeover`** (add = bot off, remove = bot on).

---

## Webhook body (must match what the worker parses)

The worker reads: `contactId`, `messageId`, `messageType`, `body`, `phone`,
`tags`, and optional `customData.{goal,painPoint}`. Use exactly:

**Inbound Reply workflow body:**
```json
{
  "type": "InboundMessage",
  "contactId": "{{contact.id}}",
  "messageId": "{{message.id}}",
  "messageType": "SMS",
  "body": "{{message.body}}",
  "phone": "{{contact.phone}}",
  "tags": "{{contact.tags}}"
}
```

**First-Touch webhook body (verified against Spiffy's live action):**
```json
{
  "type": "InitialTouch",
  "contactId": "{{contact.id}}",
  "body": "__INITIAL_TOUCH__",
  "phone": "{{contact.phone}}"
}
```
`__INITIAL_TOUCH__` tells the worker to send the persona's opener (it records
`openerSent` so it won't double-open on the reply). The worker fetches tags via
the contact API, so `tags` is not needed in this body.

---

## The workflows (clone Spiffy's; these are the specs)

### Meghan · 01 First Touch  (CLONE of Spiffy's — worker sends the opener)
- **Trigger:** Contact tag added `meghan-lead` (or Contact Created filtered to
  Meghan's assigned line/pipeline). Ownership gate — mutually exclusive w/ Spiffy.
- **Step 1:** Assign to user = Meghan (routing/ownership).
- **Step 2:** If/Else — if any shutoff tag present → end.
- **Step 3:** Custom Webhook (identical to Spiffy's "Send Initial Message",
  only the URL differs):
  - Event CUSTOM, Method POST
  - URL `https://gbt-meghan.gobluetours.workers.dev/webhook/ghl/inbound-sms`
  - Header `x-ghl-webhook-secret` = `{{custom_values.xghlwebhooksecret}}`
  - Content-Type application/json, Raw Body:
    ```json
    { "type": "InitialTouch", "contactId": "{{contact.id}}", "body": "__INITIAL_TOUCH__", "phone": "{{contact.phone}}" }
    ```
- **Step 4:** End. The worker sends her opener and adds `ai-bot-engaged` itself.
- **NO hardcoded opener/intro SMS.** The worker owns every word of the opener.

### Meghan · 02 Inbound Reply
- **Trigger:** Customer Replied → Channel = SMS, **scoped to Meghan's line.**
- **Step 1:** If/Else — any shutoff tag → end.
- **Step 2:** Custom Webhook — Inbound-Reply body above.
- **Step 3:** Wait 30 seconds (dedup guard; worker is also idempotent on
  `{contactId, messageId}`).
- **Step 4:** End.

### Meghan · 03 Shutoff
- **Triggers (any):** tag added `human-takeover` / `call-booked` / `customer` /
  `booked` / `traveler` / `do-not-message`; OR a team member sends a manual SMS
  from the inbox on Meghan's line.
- **Steps:** Remove `ai-bot-engaged` → Cancel *Meghan · 04 Follow-up* → Create
  note "Meghan disengaged ({{trigger.name}})" → End.
- (The worker also self-shuts-off via the `human-takeover` tag on the next
  inbound; this workflow is the belt-and-suspenders + cadence cancel.)

### Meghan · 04 Follow-up Cadence
- **Trigger:** tag added `ai-bot-engaged`.
- **Bodies:** use `MEGHAN_FOLLOWUPS` from `worker/src/prompts/followups.ts`
  (day1 / day3 / day7, her voice, hook baked into day7). NEVER the Spiffy
  bodies. Each step gated on still-engaged (tag present, no inbound since).

### Meghan · 05 Needs-Human Alert
- **Trigger:** tag added `needs-human`.
- **Steps:** Internal notification / task to Meghan (or the team) to take over.
  `needs-human` is an ALERT only; the paired `human-takeover` is what stops
  the bot.

---

## The email/quote loop (her flow is email-first — matters more than Spiffy's)

When a lead gives their email, the worker fires the `send-breakdown-email` tag
(first capture only). Build:
- **Meghan · Quote Email** workflow: trigger `send-breakdown-email-meghan` (her worker fires this persona-namespaced tag as of Jul 14 — Spiffy keeps `send-breakdown-email`) → back
  office sends the quote (or task to send) → add `breakdown-sent`, remove
  `send-breakdown-email`.

Until this exists, the bot correctly does NOT claim a send happened (prompt
forbids "just sent it"); it says the quote is on its way. Wire this before real
volume or leads never get pricing.

---

## Test checklist (do ALL before real leads — every item is a past live bug)

Use a test contact tagged appropriately, from a fresh phone:
- [ ] Text Meghan's line → First Touch fires once after the delay; reply shows
      **Meghan's number** as sender (not Spiffy's, not default).
- [ ] `ai-bot-engaged` applied after first touch.
- [ ] Reply to her → processed exactly once (check GHL execution log — one
      execution of Workflow 02, not two).
- [ ] **Double-text fast** (two texts back-to-back) → exactly ONE reply.
- [ ] Add `human-takeover` mid-convo → send inbound → Meghan does NOT reply.
- [ ] Send a text to **Spiffy's** line from another number → **Spiffy** replies,
      Meghan silent, and vice versa (proves the ownership gate).
- [ ] "I already booked" style inbound → silent, `needs-human` +
      `human-takeover` set, no SMS.
- [ ] `GET /debug/classify?contactId=<test>` (header `x-ghl-webhook-secret`) →
      returns a clean decision.
- [ ] Drop an email in convo → `send-breakdown-email` fires once → Quote Email
      workflow sends the quote.

---

## What I need from Derrick to finish

1. **Meghan's phone number** (E.164) once provisioned → set `SENDER_PHONE`
   secret + configure her First-Touch Send-SMS "From".
2. Confirm the **lead-ownership signal** for her workflows (a `meghan-lead`
   tag, a pipeline, or her line as the trigger scope) so gating is exact.
3. (Nice-to-have) confirm the **payment-plan cadence** wording for her line
   (corpus says ~2-weeks; SBU standard is monthly-to-December).

Everything else — worker deployed, secrets set, prompt + guardrails audited,
`fromNumber` pinning coded — is done and waiting on the above.
