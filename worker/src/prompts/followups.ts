/**
 * Follow-up SMS bodies for the drip sequence.
 *
 * Cadence lives in GHL Workflow 4. These are the exact message bodies.
 * They obey all Spiffy voice rules and guardrail rules: no dashes, no
 * emoji, no staff names, no summary labels, one question max, no
 * reservation link (link budget is reserved for live conversations).
 *
 * The cadence (+1d / +3d / +7d) matches the playbook default.
 *
 * Wording (v4.5 round, May 14): tightened against the 84-convo cold-
 * lead corpus. The dominant failure mode across that corpus is silent
 * ghosting after qualifying info is given. Real Spiffy follow-ups in
 * that corpus reference the group / the reservation specifically, not
 * generic "any thoughts on the options" filler. These bodies mirror
 * that pattern. Single-question max preserved.
 *
 * v4.5 also mandates a follow-up hook before any passive release; the
 * day7 body bakes the hook into the warm exit so the lead has a
 * concrete reason to come back.
 */

export const FOLLOWUPS = {
  /** +1 day no reply, soft personal check in. */
  day1: "yoo checkin in, hows the squad lookin?",

  /** +3 days no reply, plant urgency without naming a date. */
  day3:
    "hey checkin in, things are still moving quick over here. lmk if y'all wanna keep it going and ill see what we still have for your week",

  /** +7 days no reply, warm last nudge with the hook baked in. */
  day7:
    "last one from me for now, no pressure. if spring break is still a thing for y'all just hit me back and ill see what we got. ill also hit you up if I see prices moving or things selling out for your week",
};
