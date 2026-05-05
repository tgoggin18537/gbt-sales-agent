# GHL Email Send Workflow — Spiffy V5

Built May 5, 2026. Blocker for V5 #1.1 (email cadence fix). The V5 bot prompt says "bet, one sec" after the lead gives their email, then this workflow fires and sends the breakdown. The bot then says "just sent that over lmk if you got it" once the workflow tag flips.

## Workflow architecture (GHL)

**Trigger:** Contact tag added: `send-breakdown-email`

**Steps:**

1. **Wait:** 0 seconds (or 30 seconds if you want it to feel less "instant-bot")
2. **Send Email:** template below, sent to the contact's email field
3. **Add Tag:** `breakdown-sent` (this is what tells the bot the email landed, so the bot can say "just sent that over lmk if you got it")
4. **Remove Tag:** `send-breakdown-email` (cleanup so it doesn't re-fire)

**Sender:**
- From name: `Spiffy at SpringBreak U`
- From email: whatever Spiffy's verified domain sender is in GHL (probably `spiffy@gobluetours.com` or `spiffy@springbreaku.com`)
- Reply-to: same

**Bot integration:**
- The worker (Cloudflare side) already adds `send-breakdown-email` to the contact via the GHL API after capturing the email and emitting "bet, one sec." Verify this is in `worker/src/agents/` somewhere — if not, that's the second piece of plumbing.
- The worker checks for `breakdown-sent` tag in turn context. Once present, bot says "just sent that over lmk if you got it" on the next inbound.

---

## Email template (V1 — one universal version)

This is intentionally a single template that works regardless of which destination they picked. The bot has already been talking up their specific destination in SMS, so the email reinforces with full info on all five destinations + the universal pricing structure. V2 can add per-destination branches if Spiffy wants.

### Subject line

`spring break info, {{contact.first_name}}`

(if first_name isn't captured, fallback: `spring break info from SpringBreak U`)

### Body (HTML / rich text — keep it readable, not pretty)

```
yo {{contact.first_name}},

Spiffy from SpringBreak U here. heres everything you need for spring break.

—————————————————

THE DESTINATIONS

we run trips to 5 spots. all inclusive resorts (except Fort Lauderdale, which is domestic and hotel-only). 4 or 5 nights.

Punta Cana (Dominican Republic)
- Occidental Punta Cana — best college party vibe, most popular spot we run, where ill be too
- Occidental Caribe
- Riu Republica (21+ requirement, one per room)
- Airport: PUJ

Cancun (Mexico)
- Grand Oasis — main party resort
- Krystal — chill resort, NOT party
- Riu Caribe / Riu Cancun (Riu Caribe has the 21+ requirement)
- Airport: CUN

Cabo (Mexico)
- Riu Santa Fe (21+ requirement)
- Tesoro
- Airport: SJD

Nassau (Bahamas)
- Breezes — chill vibe, less party heavy
- Airport: NAS

Fort Lauderdale (Florida)
- Tru by Hilton — domestic, NOT all-inclusive, nightlife is off-resort
- Airport: FLL

—————————————————

WHATS INCLUDED ON ALL-INCLUSIVE TRIPS

- room at the resort
- unlimited food and drinks on resort
- airport transfers (round trip)
- all on-resort parties and events
- 24/7 staff on site
- all government taxes and fees

—————————————————

WHATS NOT INCLUDED

- flights (you book those separate, its cheaper that way. just use the airport code above)
- party pass (optional add-on for off-resort clubs)
- excursions like ATVs, jetskis, snorkel tours (booked at the resort concierge desk)
- travel insurance (optional, third party through Travel Insured)

—————————————————

THE PARTY PASS (optional)

Cancun: $210 (3 night), $269 (4 night), $299 (5 night). $1 trolley shuttle to and from clubs.
Punta Cana: priced per event. Includes Coco Bongo, Imagine Cave, Maroca, Mangu, and a booze cruise. Coach bus transport.
Cabo: priced per event.
Nassau: $289 for a 4-event bundle (Aura, Bahamas Cove, Senor Frogs, and a booze cruise).

—————————————————

THE PAYMENT PLAN

$100 deposit per person locks your spot (after January 1 it bumps to $200).
$100 per month installments after the deposit.
Final balance due in December (exact date depends on your travel date).

Takes the pressure off so its not one big payment.

—————————————————

ROOMS

2 double beds standard for groups of 3 to 4 sharing.
Max 4 per room standard, 3 at Riu Republica.
Pricing is per person, more people per room = cheaper per person.

21+ requirement applies at Riu Republica (Punta Cana), Riu Santa Fe (Cabo), and Riu Caribe (Cancun) — one person per room needs to be 21+ for check-in.

—————————————————

GROUP LEADER PERK

Get 15 travelers in your group FULLY PAID (final balance complete, not just deposited) and your trip is comped. Payments reimbursed, final balance waived.

—————————————————

TRAVEL INSURANCE (optional)

Through Travel Insured. Covers up to 75% of payments, Cancel For Any Reason policy. Pricing depends on age, state, and trip cost — pull your exact quote here:

[Insert Travel Insured link]

—————————————————

WHATS NEXT

When youre ready to lock in, just text me back and ill send the reservation link. Once your deposit goes through, the rest of the group can start depositing into the open spots in the room.

Hit me on text with any questions, im on my phone.

— Spiffy
SpringBreak U / Go Blue Tours
[Spiffy's phone number]
```

---

## Notes on voice

- All lowercase starts on most lines, occasional capital where it reads right
- Dropped apostrophes ("heres", "youre", "im", "ill") = on-brand for Spiffy
- No emojis (Spiffy used 8-15 across 22k lines)
- Em dashes nowhere (those triple-em separators above are just visual rules, not punctuation. Use a horizontal rule `<hr>` in HTML instead, or leave the dash row as a visual separator in plain text)
- Sign-off: "— Spiffy" with a single em dash IS the only place an em dash is allowed (sign-offs are conventional). If you want zero em dashes anywhere, use just "Spiffy" or "spiffy" no dash.

**Actually for compliance with Thomas's no-em-dashes rule, replace `—————————————————` with `~~~~~~~~~~~~~~~~~` or `=================` or just blank lines. And the sign-off should be `Spiffy` no dash.**

---

## Replacement (no em dashes anywhere)

Use this version if Thomas wants the no-em-dash rule applied to the email too:

Replace every `—————————————————` line with `=================` (equals signs, 17 chars).

Replace the sign-off `— Spiffy` with just `Spiffy` on its own line.

The body line about flights ("its cheaper that way. just use the airport code above") was already comma-built, no em dash there. Good.

---

## Custom fields needed in GHL

For the merge tags to populate, these need to exist on the Contact:

- `first_name` (standard GHL field, already exists)
- `email` (standard, already exists)

**Optional for V2 personalization (not needed for V1):**
- `destination` (custom field, set by bot via API when destination is captured)
- `week` (custom field)
- `group_size` (custom field)
- `school` (custom field)

V1 ships with first_name only. V2 (later) personalizes the email per destination once we wire the bot to set those custom fields via the GHL API.

---

## Test plan after the workflow is built

1. Manually add tag `send-breakdown-email` to a test contact in GHL (use Thomas's own email as the test contact's email)
2. Confirm the email lands in Thomas's inbox within 60 seconds
3. Confirm the `breakdown-sent` tag appears on that test contact after the email sends
4. Confirm `send-breakdown-email` was removed
5. Then run an SMS conversation end-to-end with the bot to confirm:
   - Bot asks for email softly
   - Lead provides email
   - Bot says "bet, one sec" and stops
   - Worker adds `send-breakdown-email` tag (this is the part to verify in worker code if not already wired)
   - Workflow fires, email lands
   - Worker sees `breakdown-sent` tag on next turn context, bot says "just sent that over lmk if you got it"

---

## Open questions for Thomas while building

1. **Sender email address:** what's the verified domain in GHL? `spiffy@gobluetours.com`, `spiffy@springbreaku.com`, or something else?
2. **Travel Insured link:** what's the actual URL Spiffy uses? Affiliate link or generic landing page?
3. **Spiffy's phone number:** what number to put in the email signature?
4. **First name fallback:** if `contact.first_name` is empty, what's the greeting? Probably `yo,` (just no name)
5. **Verify worker side adds `send-breakdown-email` tag:** if not yet, that's the second build today
