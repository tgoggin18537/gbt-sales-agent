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
      'You classify whether a text message indicates the sender is an EXISTING customer of a spring break travel company (already booked / already traveling / already deposited). Reply with exactly YES or NO. Signals for YES: mentions of being booked already, having a reservation, having paid a deposit, asking about their trip that is already locked in, referencing a room they already have, questions about their upcoming travel dates, questions while in-country or at the airport for their trip. Do NOT say YES for someone who is asking about booking for the first time, asking for pricing, or asking general questions.',
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
