/**
 * Small, cheap classifiers run via Haiku. Used for:
 *  - Existing customer detection (do not engage, alert team)
 *  - Email extraction (capture if present)
 *  - Intent signal (agreed_to_book / objection / question / stall)
 */

import { callClaude } from '../integrations/anthropic';

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

export async function classifyExistingPatient(
  apiKey: string,
  inbound: string,
): Promise<boolean> {
  const res = await callClaude({
    apiKey,
    model: CLASSIFIER_MODEL,
    systemCached:
      `You classify whether a text message contains EXPLICIT evidence the sender is already a customer of a spring break travel company (they have already booked / paid a deposit / are currently on their trip). Reply with exactly YES or NO.

Default is NO. Only say YES if the message contains an unambiguous self-reference to having already transacted.

YES signals (require explicit phrasing, not inference):
- "I already booked" / "already paid" / "already deposited" / "I'm booked"
- "my reservation" / "my room" / "my package" / "my confirmation"
- "I paid the $200" / specific past payment reference
- references to being at the airport or on-site for their trip ("we just landed", "im at the resort")
- asking about a confirmation number, itinerary, or check-in

DO say NO for everything else, including:
- a lead answering a qualifying question (e.g. "next week", "march 2-9", "10 of us", "Punta Cana", "UConn")
- mentions of dates, weeks, schools, group size, destinations, budget
- pricing questions / "how much" / "whats included"
- general intro replies ("hey", "whats up man", "yo")
- hesitation, stalls, or "let me ask my group"
- questions about upcoming spring break in the abstract (the lead is shopping, not booked)

When in doubt, say NO. A false YES tells the bot to abandon a hot lead.`,
    messages: [{ role: 'user', content: inbound }],
    maxTokens: 3,
    temperature: 0,
  });
  return res.text.trim().toUpperCase().startsWith('YES');
}

export function extractEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m?.[0];
}

/**
 * Deterministic qualifier extraction (June 18). Pulls week / destination /
 * group size / school out of an inbound so the webhook can persist them to
 * DO state and the turn context can tell the bot "you already have this,
 * don't ask again". This is the bulletproof fix for the multi-fact-dump
 * miss ("second week of march, punta cana, 8 of us from UGA" → bot asked
 * for destination it was already given). Zero latency, zero model
 * dependency, fully predictable.
 *
 * Conservative by design: only captures high-confidence signals. When a
 * field is ambiguous it returns undefined and the model handles it.
 */
export type ExtractedQualifiers = {
  week?: string;
  destination?: string;
  /** Set when the lead names 2+ destinations they're weighing ("punta cana
   *  or cabo"). The bot must PUSH (recommend Occidental Punta Cana), NOT
   *  keep asking "which destination" — re-asking trips the qualifier-repeat
   *  guard and eventually shuts the bot off. */
  destinationOptions?: string[];
  groupSize?: string;
  school?: string;
};

// Closed set of destinations + their aliases → canonical name. Destination
// is a fixed catalog, so this is 100% reliable.
const DESTINATION_ALIASES: Array<{ canonical: string; rx: RegExp }> = [
  // "punta", "punta cana", and the comma-split "punta, cana" all mean Punta Cana.
  { canonical: 'Punta Cana', rx: /\b(punta(?:[\s,]+cana)?|occidental(?:\s+(?:punta|caribe))?|riu\s+republica)\b/i },
  { canonical: 'Cancun', rx: /\b(cancun|grand\s*oasis|krystal|riu\s+caribe|riu\s+cancun)\b/i },
  { canonical: 'Cabo', rx: /\b(cabo|riu\s+santa\s*fe|tesoro)\b/i },
  { canonical: 'Nassau', rx: /\b(nassau|bahamas|breezes)\b/i },
  { canonical: 'Fort Lauderdale', rx: /\b(fort\s*lauderdale|lauderdale|laudy|tru\s+by\s+hilton)\b/i },
  { canonical: 'Jamaica', rx: /\b(jamaica|montego|negril)\b/i },
];

// Curated unambiguous college abbreviations (avoid 2-letter ones that
// collide with common words like "BU"/"UK"). Extend as real leads come in.
const KNOWN_SCHOOL_ABBR =
  /\b(UGA|FSU|UNC|UCF|UCLA|USC|LSU|PSU|OSU|ASU|SMU|TCU|UVA|UMD|UMASS|UCONN|UMICH|MSU|UIUC|SDSU|UT|UF|UGA)\b/;

export function extractQualifiers(text: string): ExtractedQualifiers {
  const out: ExtractedQualifiers = {};
  if (!text) return out;
  const t = text.trim();

  // --- Destination (closed set). Handle negation ("definitely not Cancun"
  //     must NOT capture Cancun) and the multi-option case. ---
  const NEGATION_BEFORE = /\b(not|no|anything\s+but|except|besides|don'?t\s+want|hate|skip|avoid|other\s+than)\b[^.?!]{0,15}$/i;
  const hitFamilies: string[] = [];
  for (const d of DESTINATION_ALIASES) {
    const m = d.rx.exec(t);
    if (!m) continue;
    // Look at the ~20 chars immediately before the match for a negation.
    const before = t.slice(Math.max(0, m.index - 20), m.index);
    if (NEGATION_BEFORE.test(before)) continue; // excluded, not chosen
    hitFamilies.push(d.canonical);
  }
  const uniqueFamilies = [...new Set(hitFamilies)];
  if (uniqueFamilies.length === 1) {
    out.destination = uniqueFamilies[0];
  } else if (uniqueFamilies.length >= 2) {
    // A comparison — capture as options so the bot pushes instead of re-asking.
    out.destinationOptions = uniqueFamilies;
  }

  // --- Group size. Require a group-context word so we never grab a date
  //     number ("march 9th" must NOT become group size 9). ---
  const groupMatch =
    t.match(/\b(\d{1,3})\s*(?:of\s*us|ppl|people|kids|guys|girls|dudes|friends|of\s*em|in\s+(?:my|our|the)\s+group)\b/i) ||
    t.match(/\b(?:we'?re|we\s+are|there'?s|there\s+are|group\s+of|squad\s+of|crew\s+of)\s+(?:about\s+|like\s+|around\s+|maybe\s+)?(\d{1,3})\b/i);
  if (groupMatch) {
    const n = parseInt(groupMatch[1], 10);
    if (n >= 1 && n <= 200) out.groupSize = String(n);
  }

  // --- Week. Loose by design — capture whatever week/date signal they gave. ---
  const weekMatch =
    t.match(/\bweek\s+(?:one|two|three|four|1|2|3|4)\b/i) ||
    t.match(/\b(?:first|second|third|fourth|1st|2nd|3rd|4th)\s+week(?:\s+of\s+\w+)?\b/i) ||
    t.match(/\b(?:early|mid|late)\s+(?:march|april|feb(?:ruary)?)\b/i) ||
    t.match(/\b(?:march|april|feb(?:ruary)?|jan(?:uary)?|may)\s+\d{1,2}(?:st|nd|rd|th)?\s*(?:[-–]|to|thru|through)\s*\d{1,2}(?:st|nd|rd|th)?\b/i) ||
    t.match(/\b(?:march|april|feb(?:ruary)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/i) ||
    t.match(/\bspring\s+break\s+is\s+([\w\s\-]{3,20})\b/i);
  if (weekMatch) out.week = weekMatch[0].trim();

  // --- School. High-confidence only: known abbreviation OR an explicit
  //     "from/at/go to <Proper Noun> University/State/College/Tech". ---
  const abbr = t.match(KNOWN_SCHOOL_ABBR);
  if (abbr) {
    out.school = abbr[1].toUpperCase();
  } else {
    const named = t.match(
      /\b(?:from|at|go\s+to|attend|we'?re\s+at|out\s+of)\s+((?:[A-Z][a-zA-Z&.]+\s+){0,3}(?:University|State|College|Tech|Institute|U)\b(?:\s+of\s+[A-Z][a-zA-Z]+)?)/,
    );
    if (named) out.school = named[1].replace(/\s+/g, ' ').trim();
  }

  return out;
}

export async function classifyAgreedToBook(
  apiKey: string,
  inbound: string,
): Promise<boolean> {
  const res = await callClaude({
    apiKey,
    model: CLASSIFIER_MODEL,
    systemCached:
      'You classify whether a short text reply indicates the person is agreeing to book a spring break trip / receive a reservation link / lock in a deposit. Reply exactly YES or NO. YES signals: "sure", "yes", "ok", "send it", "book me", "lets do it", "lets run it", "im in", "send the link", "lock it in", "we ready". NO signals: questions, hesitation, pushback, "let me ask my group", "not yet".',
    messages: [{ role: 'user', content: inbound }],
    maxTokens: 3,
    temperature: 0,
  });
  return res.text.trim().toUpperCase().startsWith('YES');
}
