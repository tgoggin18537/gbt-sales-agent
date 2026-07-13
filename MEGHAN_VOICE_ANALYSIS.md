# Meghan Voice Analysis — Quantitative Corpus Study

Basis for every voice rule in `worker/src/prompts/meghan.ts`. Method: parsed
both conversation exports (94 conversations, 6,919 messages), classified
direction by delivery status (3,395 Meghan-side / 3,524 lead), then removed
automated template sends (34 distinct canned lines appearing in 4+
conversations, 543 sends) leaving **2,852 spontaneous, human-typed Meghan
messages** as the voice corpus. All numbers below are measured on that set.

## Message shape
| Metric | Value |
|---|---|
| Median length | 12 words / 63 chars (p25: 7, p75: 19 words) |
| Ultra-short (1-3 words) | 8.9% |
| Long (>30 words) | 6.0% |
| Questions | 31.3% of messages; multi-question messages only 1.8% |
| Burst behavior | median 1 msg per turn; 29% of turns are 2-4 rapid texts |
| Reply latency | median 6.5 min (p25 1.2m, p75 78m) |

## Terminal punctuation (the defining fingerprint)
| Ending | Share |
|---|---|
| **nothing** | **52.8%** |
| ? | 27.3% |
| ! | 14.4% |
| smiley | 2.2% |
| bare period | **1.7%** |
| !! | 1.5% |

Statements just stop or end warm. A trailing period is practically foreign to
her (1 in 60). Questions always get their mark.

## Warmth channels
- "!" appears in 47.8% of messages. "!!" in 3.4%. "!!!" twice in 2,852.
- ":)" in 2.5% of messages (72 total) — a garnish, not a habit. ":(" for bad news (7).
- Emoji: effectively zero (4, all template bleed).
- ALLCAPS emphasis ("SO sorry"): rare spice, 19 messages.

## Correctness
- Contractions: 615 correct apostrophes vs 1 dropped (99.8% clean).
- Lowercase sentence starts: 1.6% (sentence case is the rule).
- Em dashes: 0. Ellipses: 0. Asterisk typo-corrections: present but rare.

## Lexicon (messages containing, ranked)
Perfect (157) · Yes! (96) · Awesome (76) · Just sent (63) · sorry (50) ·
"Let me know if you received/got it" (52 combined) · Sounds good (28) ·
No worries (24) · Keep me posted (11) · a pinch (9) · Good/Great choice (15) ·
lmk (6) · pp (6) · np (3) · Hope that helps (2) · lyk (1)

**"Of course": 1 use in 2,852 messages.** Slang (bet/word/aight/yea/fs/dope/lit): **zero**.

## Consequences for the prompt (fixes made after measurement)
1. Punctuation rule rewritten: no-period endings are the default for statements; bare trailing periods flagged as off-voice.
2. ":)" recalibrated from "1 in 6" (extraction impression) to measured "1 in 40, sparing".
3. Lowercase-start rule removed as a deliberate behavior (1.6% reality).
4. Acknowledgment lexicon re-ranked to her real frequencies; **"Of course" banned** — it had leaked into three generations. Prompt bans alone did not remove it (argmax-stable), so it is now **mechanically enforced**: `MEGHAN_BANNED_PHRASES` in meghan.ts, checked by the guardrail with regenerate-on-hit (verified live: attempt 1 caught, attempt 2 clean).
5. "a pinch" kept as signature but rate-limited to ~once per conversation (9 total uses in corpus).
6. Slang list mechanically banned as well, protects against voice bleed from the Spiffy-voiced FAQ reference block.

## Notes for pacing (future)
Her median reply latency is 6.5 minutes; the bot replies in seconds. If Derrick
ever wants human-indistinguishable pacing, a 1-4 minute randomized delay would
match her p25-median band. Not in V1 scope.
