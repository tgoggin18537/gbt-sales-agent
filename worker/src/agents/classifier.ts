/**
 * Small, cheap classifiers run via Haiku. Used for:
 *  - Existing patient detection (do not engage, alert team)
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
