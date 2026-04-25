/**
 * Follow-up SMS bodies for the drip sequence.
 *
 * Cadence lives in GHL Workflow 4. These are the exact message bodies.
 * They obey all Spiffy voice rules and guardrail rules: no dashes, no
 * emoji, no staff names, no summary labels, one question max, no
 * reservation link (link budget is reserved for live conversations).
 *
 * The cadence (+1d / +3d / +7d) matches the playbook default. Spiffy's
 * own cadence wasn't cleanly derivable from timestamps in the corpus,
 * so the cadence is copied from the playbook and the BODIES are Spiffy.
 * See SPIFFY_V2_QUESTIONS.md to confirm cadence with Spiffy.
 */

export const FOLLOWUPS = {
  /** +1 day no reply, soft check in. */
  day1: "yoo checkin in. any thoughts on the options I sent over?",

  /** +3 days no reply, gentle urgency. */
  day3:
    "yoo just a heads up, availability for these spots has been moving fast this time of year. lmk if yall wanted to keep it going",

  /** +7 days no reply, warm last nudge. */
  day7:
    "last one from me for now, no pressure. if spring break is still on the radar just hit me back and ill send fresh options",
};
