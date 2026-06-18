/**
 * Deterministic tests for extractQualifiers.
 * Run: npx tsx worker/src/agents/extractQualifiers.test.ts
 */
import { extractQualifiers, type ExtractedQualifiers } from './classifier';

type Case = { name: string; input: string; expect: ExtractedQualifiers; forbid?: (keyof ExtractedQualifiers)[] };

const cases: Case[] = [
  // --- THE BUG: multi-fact dump with destination must capture destination ---
  {
    name: 'BUG: "second week of march, punta cana, 8 of us from UGA"',
    input: 'second week of march, punta cana, 8 of us from UGA',
    expect: { destination: 'Punta Cana', groupSize: '8', school: 'UGA' },
  },
  {
    name: 'prompt example: "March 2-9, Punta Cana, 10 of us from Michigan State"',
    input: 'March 2-9, Punta Cana, 10 of us from Michigan State',
    expect: { destination: 'Punta Cana', groupSize: '10', school: 'Michigan State' },
  },
  // --- TWO destinations = comparison → capture NOTHING for destination ---
  {
    name: 'two destinations "Punta, Cana or Cabo" → options, not single destination',
    input: 'Punta, Cana or Cabo',
    expect: { destinationOptions: ['Punta Cana', 'Cabo'] as any },
    forbid: ['destination'],
  },
  {
    name: 'NEGATION: "Definitely not Cancun" must NOT capture Cancun',
    input: 'Definitely not Cancun',
    expect: {},
    forbid: ['destination', 'destinationOptions'],
  },
  {
    name: 'mixed: "Punta or Cabo, definitely not Cancun" → options [Punta,Cabo], Cancun excluded',
    input: 'Punta, Cana or Cabo. Definitely not Cancun',
    expect: { destinationOptions: ['Punta Cana', 'Cabo'] as any },
    forbid: ['destination'],
  },
  {
    name: 'single destination via resort name "grand oasis"',
    input: 'we wanna do grand oasis',
    expect: { destination: 'Cancun' },
  },
  // --- group size must NOT grab date numbers ---
  {
    name: 'date number not captured as group size: "march 9th"',
    input: 'march 9th works for us',
    expect: { week: 'march 9th' },
    forbid: ['groupSize'],
  },
  {
    name: 'group via "we are 12"',
    input: 'we are 12 going',
    expect: { groupSize: '12' },
  },
  {
    name: 'group via "group of 15"',
    input: 'group of 15 from FSU',
    expect: { groupSize: '15', school: 'FSU' },
  },
  // --- week variants ---
  { name: 'week 2', input: 'week 2 i think', expect: { week: 'week 2' } },
  { name: 'second week', input: 'second week of march', expect: { week: 'second week of march' } },
  { name: 'date range', input: 'march 6-12 for us', expect: { week: 'march 6-12' } },
  // --- school: only high-confidence ---
  {
    name: 'school via "from X University"',
    input: 'we are from Boston University',
    expect: { school: 'Boston University' },
  },
  {
    name: 'no false school capture from generic words',
    input: 'we just wanna party honestly',
    expect: {},
    forbid: ['school', 'destination', 'groupSize'],
  },
  // --- empty / junk ---
  { name: 'empty string', input: '', expect: {} },
  { name: 'greeting only', input: 'yo whats up man', expect: {} },
];

let pass = 0,
  fail = 0;
for (const c of cases) {
  const got = extractQualifiers(c.input);
  const fails: string[] = [];
  for (const k of Object.keys(c.expect) as (keyof ExtractedQualifiers)[]) {
    if ((got[k] ?? '').toString().toLowerCase() !== (c.expect[k] ?? '').toString().toLowerCase()) {
      fails.push(`${k}: got ${JSON.stringify(got[k])} want ${JSON.stringify(c.expect[k])}`);
    }
  }
  for (const k of c.forbid ?? []) {
    if (got[k] !== undefined) fails.push(`${k} should be undefined, got ${JSON.stringify(got[k])}`);
  }
  if (fails.length === 0) {
    console.log(`[PASS] ${c.name}`);
    pass++;
  } else {
    console.log(`[FAIL] ${c.name}`);
    for (const f of fails) console.log(`   - ${f}`);
    console.log(`   full: ${JSON.stringify(got)}`);
    fail++;
  }
}
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
