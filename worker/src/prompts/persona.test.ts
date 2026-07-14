/**
 * Persona regression guard.
 *
 * Exists because THREE live bugs came from Spiffy-flavored text reaching
 * Meghan's model through shared code (turn-context coaching, guardrail
 * rewrites, FAQ reference examples). This test assembles Meghan's REAL
 * prompt surface — full system prompt + representative turn contexts —
 * and mechanically asserts the known hazard classes never reappear.
 *
 * Run: npm run test:persona   (wired into test:unit)
 */
import { MEGHAN_SYSTEM_PROMPT, MEGHAN_OPENER, MEGHAN_BANNED_PHRASES } from './meghan';
import { SPIFFY_SYSTEM_PROMPT, buildTurnContext } from './spiffy';
import { renderFaqForPrompt } from './faq';
import { FOLLOWUPS, MEGHAN_FOLLOWUPS } from './followups';
import { applyGuardrail } from '../agents/guardrail';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}`);
    if (detail) console.log(`      ${detail}`);
  }
}

// ---------- Assemble Meghan's full prompt surface ----------
const meghanPrompt = `${MEGHAN_SYSTEM_PROMPT}\n\n${renderFaqForPrompt('meghan')}`;

const NOW = new Date('2026-11-10T12:00:00Z'); // fixed date: deterministic season
const meghanTurnCtxs = [
  buildTurnContext({ persona: 'meghan', linkSendCount: 0, nowOverride: NOW }),
  buildTurnContext({ persona: 'meghan', linkSendCount: 0, nowOverride: NOW, openerAlreadySent: true }),
  buildTurnContext({ persona: 'meghan', linkSendCount: 0, nowOverride: NOW, depositAmount: 200 }),
  buildTurnContext({ persona: 'meghan', linkSendCount: 2, nowOverride: NOW, week: 'week 2', groupSize: '6' }),
  buildTurnContext({ persona: 'meghan', linkSendCount: 0, nowOverride: NOW, destinationOptions: ['Punta Cana', 'Cancun'] }),
  // january + february seasonal framings (had "2-3 days" / "if we actually have rooms" hazards)
  buildTurnContext({ persona: 'meghan', linkSendCount: 0, nowOverride: new Date('2027-01-10T12:00:00Z') }),
  buildTurnContext({ persona: 'meghan', linkSendCount: 0, nowOverride: new Date('2027-02-10T12:00:00Z') }),
].join('\n');
const meghanSurface = `${meghanPrompt}\n${meghanTurnCtxs}`;

// ---------- TIER A: hazards that must NEVER appear anywhere in her surface ----------
const HAZARDS: Array<[string, RegExp]> = [
  ['on-site presence claim', /\b(?:that'?s\s+where\s+)?i'?ll\s+(?:personally\s+)?be\s+(?:there\b|too\b|in\s+punta|at\s+the\s+(?:occidental|resort)|on\s*site)/i],
  ['where-ill-be claim', /\bwhere\s+i'?ll\s+be\b/i],
  ['spiffy identity leak', /\bthis\s+(?:is\s+)?spiffy\b|\bit'?s\s+spiffy\b|\bderrick\b/i],
  ['destination lumping', /\b(?:those are|they'?re) all (?:great(?: options)?|a vibe|solid|the same)\b/i],
  ['spiffy coached deposit typo', /right now its \$/],
  ['SBU brand coaching', /LEAD BRAND: SpringBreak U/],
  ['deadline-days coaching', /\b2-3 days\b/i],
  ['live-inventory coaching', /if we actually have rooms/i],
  ['whats-good greeting', /what'?s good, it'?s/i],
];
for (const [name, rx] of HAZARDS) {
  const m = meghanSurface.match(rx);
  check(`meghan surface free of: ${name}`, !m, m ? `matched: "...${meghanSurface.slice(Math.max(0, m.index! - 40), m.index! + 60).replace(/\n/g, ' ')}..."` : undefined);
}

// ---------- TIER B: positive invariants ----------
check('meghan turn ctx brands as Go Blue Tours', meghanTurnCtxs.includes('LEAD BRAND: Go Blue Tours'));
check('meghan qualifier order has no school/timeline', !/order: week, destination, group size, school, timeline/.test(meghanTurnCtxs));
check('meghan FAQ render labeled facts-only', meghanPrompt.includes('FACTS ONLY'));
check('meghan FAQ safety answer overridden', !/ill be in Punta Cana personally/i.test(meghanPrompt));
check('meghan reaction block overridden (no "word thats")', !/word thats where/i.test(meghanPrompt));
check('spiffy prompt still has his voice (control)', /bet/.test(SPIFFY_SYSTEM_PROMPT) && /thats where ill be too/.test(SPIFFY_SYSTEM_PROMPT));
check('spiffy FAQ render unchanged label (control)', renderFaqForPrompt('spiffy').includes("Spiffy's vibe"));
check('spiffy turn ctx still brands SBU by default (control)', buildTurnContext({ linkSendCount: 0, nowOverride: NOW }).includes('LEAD BRAND: SpringBreak U'));

// ---------- TIER C: her canned copy passes her own guardrail ----------
const cannedBodies: Array<[string, string]> = [
  ['MEGHAN_OPENER', MEGHAN_OPENER],
  ...Object.entries(MEGHAN_FOLLOWUPS).map(([k, v]) => [`MEGHAN_FOLLOWUPS.${k}`, v] as [string, string]),
];
for (const [name, body] of cannedBodies) {
  const g = applyGuardrail({
    candidate: body,
    linkSendCountBefore: 0,
    isFirstMessage: name === 'MEGHAN_OPENER',
    priorAssistantMessages: [],
    persona: 'meghan',
    extraBannedPhrases: MEGHAN_BANNED_PHRASES,
  } as any);
  check(`${name} passes meghan guardrail`, g.ok, g.ok ? undefined : `reason: ${(g as any).reason}`);
}
check('followup keys match (spiffy/meghan drip parity)',
  JSON.stringify(Object.keys(FOLLOWUPS).sort()) === JSON.stringify(Object.keys(MEGHAN_FOLLOWUPS).sort()));

// ---------- TIER D: guardrail behavior invariants for her mandated lines ----------
const hook = "Totally your call! I'm here whenever you're ready, and I'll reach out if I see prices moving or your week filling up";
const gHook = applyGuardrail({
  candidate: hook,
  linkSendCountBefore: 0,
  isFirstMessage: false,
  priorAssistantMessages: ['Totally understand! The Tesoro is a pinch cheaper if you want options'],
  persona: 'meghan',
  extraBannedPhrases: MEGHAN_BANNED_PHRASES,
} as any);
check('her mandated release hook survives guardrail (reach-out + totally)', gHook.ok, gHook.ok ? undefined : `reason: ${(gHook as any).reason}`);

const gLump = applyGuardrail({
  candidate: "Those are all great options! Punta Cana has been our most popular this year. Which one are you leaning toward?",
  linkSendCountBefore: 0,
  isFirstMessage: false,
  priorAssistantMessages: [],
  persona: 'meghan',
  extraBannedPhrases: MEGHAN_BANNED_PHRASES,
} as any);
check('destination lumping is REJECTED for meghan', !gLump.ok);

const gPresence = applyGuardrail({
  candidate: "That's where I'll be too! Punta Cana has been our most popular this year",
  linkSendCountBefore: 0,
  isFirstMessage: false,
  priorAssistantMessages: [],
  persona: 'meghan',
  extraBannedPhrases: MEGHAN_BANNED_PHRASES,
} as any);
check('clean-grammar presence claim is REJECTED for meghan', !gPresence.ok);

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
