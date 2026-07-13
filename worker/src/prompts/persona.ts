/**
 * Persona selector. One codebase, two workers:
 *   - gbt-spiffy  (wrangler.toml, PERSONA unset/"spiffy")  — unchanged behavior
 *   - gbt-meghan  (wrangler.meghan.toml, PERSONA="meghan")
 *
 * Everything defaults to Spiffy so existing deployments are untouched.
 */
import { SPIFFY_SYSTEM_PROMPT } from './spiffy';
import { MEGHAN_SYSTEM_PROMPT, MEGHAN_OPENER } from './meghan';
import { renderFaqForPrompt } from './faq';

export type PersonaKey = 'spiffy' | 'meghan';

export function personaKey(env: { PERSONA?: string }): PersonaKey {
  return (env.PERSONA ?? '').toLowerCase() === 'meghan' ? 'meghan' : 'spiffy';
}

const SPIFFY_OPENER =
  "What's good! It's Spiffy from SpringBreak U here. Which week is your spring break? I'll send over the options and deets";

/** Cached per-persona system prompt (stable prefix for prompt caching). */
const cache: Partial<Record<PersonaKey, string>> = {};

export function systemCachedFor(env: { PERSONA?: string }): string {
  const k = personaKey(env);
  if (!cache[k]) {
    const base = k === 'meghan' ? MEGHAN_SYSTEM_PROMPT : SPIFFY_SYSTEM_PROMPT;
    cache[k] = `${base}\n\n${renderFaqForPrompt()}`;
  }
  return cache[k]!;
}

export function openerFor(env: { PERSONA?: string }): string {
  return personaKey(env) === 'meghan' ? MEGHAN_OPENER : SPIFFY_OPENER;
}
