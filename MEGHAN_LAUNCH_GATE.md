# Meghan Bot — Launch Gate (do these BEFORE real leads flow)

The prompt + worker are built, audited against every Spiffy-era failure, and
deployed (gbt-meghan on GBT's Cloudflare). What remains is GHL wiring and
integration verification — every item below is a lesson already paid for on
the Spiffy line. Do not skip any.

## 1. GHL workflow pack (copy the proven Spiffy spec, swap the persona)
- Inbound-reply workflow → POST `https://gbt-meghan.gobluetours.workers.dev/webhook/ghl/inbound-sms`
  (FULL path — `/webhook` alone 404s, July 8 lesson), header `x-ghl-webhook-secret`
  from the location custom value, **shutoff If/Else as the FIRST step**.
- First-touch workflow with the `__INITIAL_TOUCH__` sentinel body.
- Shutoff workflow on manual outbound (human takeover).
- Follow-up drips: use `MEGHAN_FOLLOWUPS` copy (worker/src/prompts/followups.ts) —
  never the Spiffy bodies.
- Quote workflow: on `send-breakdown-email` tag → back-office sends quote →
  add `quote-sent` tag → remove trigger tag.

## 2. Exactly ONE owner per lead (double-reply prevention, 4/14 lesson)
Meghan's workflows must be gated on her routing (her number / pipeline / a
`meghan-lead` tag) and EXCLUDED from Spiffy's triggers, and vice versa. Two
bots answering one lead is the worst-case failure. Add the 30-second dedup
wait after the webhook step per the proven workflow spec.
Test: one inbound → exactly one reply.

## 3. Integration launch gates (June 16-18 lesson: bugs live in the GHL+DO layer)
- [ ] Back-to-back double-text from a test phone → exactly ONE reply
- [ ] "I already booked my trip" inbound → silent tags, NO SMS reply
- [ ] `GET /debug/classify?contactId=<test>` → clean
- [ ] `__INITIAL_TOUCH__` fires her opener once; re-fire does NOT double-send
- [ ] Human sends a manual SMS → bot goes silent on that contact

## 4. Known shared-worker hardening (before real volume)
- Cache the pre-send classifier recheck per contact (short TTL)
- Cap ContactThread history (~40 msgs, oldest-first eviction)
Both live in shared code and protect Spiffy too; neither is done yet.

## 5. V2 candidate (not a launch blocker)
Inject `QUOTE STATUS: sent` into turn context when the quote-sent tag is
present, so she can say "Just sent it over!" truthfully. Until then the prompt
forbids send claims entirely.

## Open question for Derrick
Payment plan wording: her 2025-26 corpus says "deposit + balance ~2 weeks
later"; the SBU standard is monthly installments to December. The prompt
currently defers to "the exact schedule is on their quote". Confirm which
cadence her line runs so we can say it plainly.
