# Spiffy bot — tag cadence (what the bot does on its own vs manual)

Last updated 2026-06-12. Source of truth: `worker/src/routes/webhook.ts`.

## The one thing that matters: how to turn the bot OFF and ON

The bot checks a **shutoff list** at the top of every inbound. If the contact has ANY of these tags, the bot stays completely silent and does nothing:

`do-not-message`, `human-takeover`, `call-booked`, `customer`, `booked`, `traveler`

**Clean kill switch = `human-takeover`.**
- Add `human-takeover` → bot stops processing that contact immediately.
- Remove `human-takeover` (and make sure none of the other shutoff tags are on the contact) → bot is live again.

That's the one clean enable/disable. `needs-human` is NOT a kill switch (see below).

---

## Tags the bot adds AUTOMATICALLY

| Tag | When the bot adds it | What it means |
|---|---|---|
| `ai-bot-engaged` | When it sends the opener / first engages a lead | Bot is active on this contact |
| `human-takeover` | (1) a teammate sends a manual SMS from the inbox, (2) an existing customer is detected, (3) the bot can't produce a safe reply and goes silent | **Bot is OFF.** This is the kill switch. It's in the shutoff list. |
| `needs-human` | Same moments as above (existing customer, or bot stuck) — always paired with `human-takeover` | **Alert flag only.** "A human should jump in here." It does NOT stop the bot by itself; the paired `human-takeover` is what stops it. |
| `send-breakdown-email` | The moment the lead first drops their email | Fires your GHL email workflow. **Active, not a test tag.** |
| `hype-up` | The moment the bot sends the school gas-up text (new, live after the 6/12 deploy) | Fires once per contact. This is the one you asked for. |

### human-takeover vs needs-human (your question)
- `human-takeover` = the bot is shut off. Remove it to turn the bot back on.
- `needs-human` = a flag that says "a person needs to handle this," but it does not gate the bot on its own.
- The bot sets BOTH together when it escalates (existing customer, or it got stuck). So in practice: if you see both, the bot stopped itself and is asking your team to take over. To resume the bot, remove `human-takeover` (you can leave or clear `needs-human`, it doesn't affect the bot).

---

## Tags the bot does NOT add (manual / workflow / leftover)

| Tag | Reality |
|---|---|
| `quote-ready` | **The bot does NOT add this.** It does not fire on email drop, the email-drop tag is `send-breakdown-email`. `quote-ready` is either a manual tag or one of your GHL workflows. Not bot-driven. |
| `breakdown-sent` | The bot does NOT add this. Your GHL email workflow should add it AFTER it sends the breakdown email (and remove `send-breakdown-email`). Informational. |
| `client` | The bot does not use it. Looks like a leftover. Safe to remove on the bot side — just confirm none of your GHL workflows key off it first. |
| `test-bot` | Manual testing tag. Not a gate in the bot. |
| `ai-bot-opener` | The bot does not use it. Manual / leftover. |

---

## Email cadence, end to end (so you can build the workflow)

1. Lead drops their email → bot adds `send-breakdown-email` (first capture only, won't re-fire).
2. Your GHL workflow triggers on `send-breakdown-email` → sends the breakdown email → adds `breakdown-sent` and removes `send-breakdown-email`.
3. (The bot keeps running the conversation the whole time; sending the email is the only human/workflow-side piece.)

## hype-up, end to end (your new tag)

1. Bot asks the school question, lead answers, bot sends the gas-up message → bot adds `hype-up` (once per contact).
2. Build your testing-phase workflow off the `hype-up` add. It fires exactly when the gas-up text goes out.
