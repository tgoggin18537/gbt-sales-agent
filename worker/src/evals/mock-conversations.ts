/**
 * Phase 5 voice validation: 15 scripted inbound scenarios, run through
 * the full Spiffy pipeline (prompt + guardrail + retry loop). Outputs
 * each conversation to stdout / a markdown file for human grading.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx src/evals/mock-conversations.ts
 */

import { callClaude } from '../integrations/anthropic';
import { SPIFFY_SYSTEM_PROMPT, buildTurnContext } from '../prompts/spiffy';
import { renderFaqForPrompt } from '../prompts/faq';
import { applyGuardrail } from '../agents/guardrail';
import { writeFileSync } from 'node:fs';

const SYSTEM_CACHED = `${SPIFFY_SYSTEM_PROMPT}\n\n${renderFaqForPrompt()}`;

const SPIFFY_OPENER =
  "What's good! It's Spiffy from SpringBreak U here. Which week is your spring break? I'll send over the options and deets";

type Turn = { role: 'user' | 'assistant'; content: string };

type Scenario = {
  name: string;
  blurb: string;
  /** Series of customer inbounds. Each one runs after the assistant replies to the prior. */
  inbounds: string[];
  /** If true, prepend the cold opener as the first assistant message. */
  openerFirst?: boolean;
  /** Seed state fields. */
  state?: {
    week?: string;
    destination?: string;
    groupSize?: string;
    school?: string;
  };
};

const SCENARIOS: Scenario[] = [
  {
    name: '01_hot_lead_moves_fast',
    blurb: 'Classic fast-mover: gives all qualifiers in two turns, wants to book.',
    openerFirst: true,
    inbounds: [
      'March 1-6 Punta Cana',
      '6 ppl from Penn State, ready to book this week',
      'lets do it',
    ],
  },
  {
    name: '02_skeptical_asks_scam',
    blurb: 'Suspicious, asks if this is legit. Needs reassurance before any questions.',
    openerFirst: true,
    inbounds: [
      'how do i know this isnt a scam',
      'ok fair, we were looking March 14-20 Cabo, 4 of us',
    ],
  },
  {
    name: '03_price_sensitive_stall',
    blurb: 'Price concern + group vote stall. Tests no-pressure payment plan handling.',
    openerFirst: true,
    inbounds: [
      'March 2-9 Punta Cana, 5 of us from Texas',
      'what does it cost',
      'idk thats kinda steep',
      'let me ask my group',
    ],
  },
  {
    name: '04_just_looking',
    blurb: 'Information-gatherer, not ready. Tests stall handler.',
    openerFirst: true,
    inbounds: [
      'just looking, not ready to book yet',
      'can you tell me whats included',
      'cool thanks',
    ],
  },
  {
    name: '05_compare_destinations',
    blurb: 'Asks Spiffy to pick a side between destinations. Tests "has opinion" rule.',
    openerFirst: true,
    inbounds: [
      'hey we cant decide between cabo and punta cana, whats your honest take',
      '8 of us from Michigan, March 1-6',
    ],
  },
  {
    name: '06_parent_safety_question',
    blurb: 'Group leader asking questions their parents asked. Safety flag.',
    openerFirst: true,
    inbounds: [
      'my mom is asking a lot of safety questions',
      'is it safe in punta cana',
    ],
  },
  {
    name: '07_existing_customer_adds_friend',
    blurb: 'Already booked, wants to add a friend. Tests that bot doesn\'t re-qualify.',
    inbounds: [
      'hey im already booked for punta march 1-6, can i add a friend',
    ],
  },
  {
    name: '08_all_facts_in_one_message',
    blurb: 'Dumps week, destination, group size, school, timeline in one text. Tests "read the message".',
    openerFirst: true,
    inbounds: [
      "March 14-20 in Cancun, 12 of us from Ohio State, lookin to book in the next couple days",
    ],
  },
  {
    name: '09_twenty_one_plus_question',
    blurb: 'Asks about age. Tests hotel-specific 21+ rule not universal.',
    openerFirst: true,
    inbounds: [
      'whats the age requirement',
      'some of us are 20, we want punta cana',
    ],
  },
  {
    name: '10_group_of_15_free_trip',
    blurb: 'Group leader qualifier for free trip. Tests 15+ rule.',
    openerFirst: true,
    inbounds: [
      'if i bring like 15 of my friends do i get a free trip',
      'yeah were looking at punta march 7-13',
    ],
  },
  {
    name: '11_flights_question',
    blurb: 'Asks about flights. Tests the "not included, book your own" answer.',
    openerFirst: true,
    inbounds: [
      'March 14-20 Cabo 4 ppl',
      'are flights included',
      'so should we book our own',
    ],
  },
  {
    name: '12_bro_mirror_allowed',
    blurb: 'Male lead uses "bro" first. Tests vocative mirror logic.',
    openerFirst: true,
    inbounds: [
      'yo bro March 1-6 punta 10 of us from Alabama',
      'lets get it bro',
    ],
  },
  {
    name: '13_email_handoff',
    blurb: 'Asks for details in writing. Tests email-ask pattern.',
    openerFirst: true,
    inbounds: [
      'March 7-13 Cancun 6 of us from UMass',
      'can you email me everything',
      'myemail@gmail.com',
    ],
  },
  {
    name: '14_group_shrunk',
    blurb: 'Group size drops mid-convo. Tests adjustment without re-qualifying.',
    openerFirst: true,
    inbounds: [
      'March 1-6 Punta Cana 10 ppl from Michigan State',
      'wait actually some people bailed, were down to 4',
    ],
  },
  {
    name: '15_terse_one_word_replies',
    blurb: 'Lead gives one-word answers. Tests energy-matching (no 3-sentence pitch).',
    openerFirst: true,
    inbounds: [
      'march 2-9',
      'cabo',
      '5',
      'USC',
      'this week',
      'ok',
    ],
  },
];

async function runScenario(apiKey: string, model: string, s: Scenario): Promise<{
  name: string;
  blurb: string;
  transcript: Turn[];
  rejected: Array<{ turn: number; reason: string; draft: string }>;
}> {
  const transcript: Turn[] = [];
  const rejected: Array<{ turn: number; reason: string; draft: string }> = [];

  if (s.openerFirst) {
    transcript.push({ role: 'assistant', content: SPIFFY_OPENER });
  }

  for (let i = 0; i < s.inbounds.length; i++) {
    const inbound = s.inbounds[i];
    transcript.push({ role: 'user', content: inbound });

    const turnCtx = buildTurnContext({
      linkSendCount: 0,
      week: s.state?.week,
      destination: s.state?.destination,
      groupSize: s.state?.groupSize,
      school: s.state?.school,
    });

    const history = transcript.map((t) => ({ role: t.role, content: t.content }));
    let reply = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await callClaude({
        apiKey,
        model,
        systemCached: SYSTEM_CACHED,
        systemDynamic: turnCtx,
        messages: history,
        maxTokens: 300,
        temperature: 0.8,
      });
      const guard = applyGuardrail({
        candidate: res.text,
        linkSendCountBefore: 0,
        isFirstMessage: transcript.filter((t) => t.role === 'assistant').length === 0,
        priorAssistantMessages: transcript
          .filter((t) => t.role === 'assistant')
          .map((t) => t.content),
      });
      if (guard.ok) {
        reply = guard.clean;
        break;
      }
      rejected.push({ turn: i, reason: guard.reason, draft: res.text });
      history.push({
        role: 'user',
        content: `[system note] Your last draft violated a rule: ${guard.reason}. Rewrite following all rules. Keep it to one short reply, one question max.`,
      });
    }
    if (!reply) reply = '[FALLBACK — guardrail exhausted]';
    transcript.push({ role: 'assistant', content: reply });
  }

  return { name: s.name, blurb: s.blurb, transcript, rejected };
}

function renderMarkdown(results: Awaited<ReturnType<typeof runScenario>>[]): string {
  const lines: string[] = [];
  lines.push('# Phase 5 — Spiffy voice validation');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()}. 15 scripted inbound scenarios, full pipeline (prompt + guardrail).`);
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.name}`);
    lines.push(`_${r.blurb}_`);
    lines.push('');
    for (const t of r.transcript) {
      const who = t.role === 'user' ? 'LEAD' : 'SPIFFY';
      lines.push(`**${who}:** ${t.content}`);
      lines.push('');
    }
    if (r.rejected.length) {
      lines.push(`<details><summary>${r.rejected.length} guardrail reject(s) this scenario</summary>`);
      lines.push('');
      for (const rj of r.rejected) {
        lines.push(`- turn ${rj.turn}, reason: ${rj.reason}`);
        lines.push(`  draft: ${rj.draft.replace(/\n/g, ' ')}`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = process.env.SPIFFY_MODEL || 'claude-sonnet-4-6';

  const results: Awaited<ReturnType<typeof runScenario>>[] = [];
  for (const s of SCENARIOS) {
    process.stdout.write(`running ${s.name}... `);
    const r = await runScenario(apiKey, model, s);
    results.push(r);
    console.log(`done (${r.rejected.length} rejects)`);
  }

  const md = renderMarkdown(results);
  const out = `${process.cwd()}/../PHASE_5_MOCK_CONVERSATIONS.md`;
  writeFileSync(out, md);
  console.log(`\nwrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
