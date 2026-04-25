/**
 * Deterministic guardrail tests for Spiffy bot.
 * Zero Claude calls, runs in under a second.
 *
 * Run:
 *   npx tsx worker/src/agents/guardrail.test.ts
 */

import { applyGuardrail } from './guardrail';

type Case = {
  name: string;
  candidate: string;
  isFirstMessage?: boolean;
  linkSendCountBefore?: number;
  priorAssistantMessages?: string[];
  inboundText?: string;
  priorAssistantLengths?: number[];
  expect:
    | { ok: true; contains?: string[]; notContains?: string[]; violationsIncludes?: string[] }
    | { ok: false; reasonIncludes: string };
};

const CASES: Case[] = [
  // ---- SELF-INITIATOR BAN ----
  {
    name: 'bans: I wanted to reach out',
    candidate: "Hey, I wanted to reach out about your spring break plans.",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: just wanted to reach out',
    candidate: "just wanted to reach out and see how the group is lookin",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: I figured Id reach out',
    candidate: "I figured I'd reach out since you were checking us out.",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: Im reaching out',
    candidate: "hey, I'm reaching out from Spring Break U",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: we reached out',
    candidate: "We reached out to check in on you.",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: Ill reach out',
    candidate: "I'll reach out later with more info.",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: thanks for reaching out',
    candidate: "thanks for reaching out about spring break",
    expect: { ok: false, reasonIncludes: 'banned' },
  },
  {
    name: 'bans: just wanted to check in',
    candidate: "just wanted to check in on you",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'ALLOWS: our team will reach out (not self-initiator)',
    candidate: "bet, our team will reach out once transport is lined up",
    expect: { ok: true },
  },
  {
    name: 'ALLOWS: checkin in (Spiffy phrasing)',
    candidate: "yoo checkin in, any thoughts on the options I sent over?",
    expect: { ok: true },
  },

  // ---- BANNED OPENERS ----
  {
    name: 'bans: great question',
    candidate: "Great question! so pricing depends on group size",
    expect: { ok: false, reasonIncludes: 'banned opener' },
  },
  {
    name: 'bans: absolutely opener',
    candidate: "Absolutely, we can help with that",
    expect: { ok: false, reasonIncludes: 'banned opener' },
  },
  {
    name: 'bans: certainly opener',
    candidate: "Certainly, Cabo is a great pick",
    expect: { ok: false, reasonIncludes: 'banned opener' },
  },
  {
    name: 'strips: Short version: as opener (label removed)',
    candidate: "Short version: $200 deposit and payment plan.",
    expect: {
      ok: true,
      notContains: ['Short version:'],
      contains: ['$200 deposit'],
      violationsIncludes: ['stripped_ai_summary_label'],
    },
  },
  {
    name: 'strips: TL;DR as opener (label removed)',
    candidate: "TL;DR: Punta Cana is the move.",
    expect: {
      ok: true,
      notContains: ['TL;DR'],
      contains: ['Punta Cana is the move'],
      violationsIncludes: ['stripped_ai_summary_label'],
    },
  },

  // ---- SUMMARY LABEL STRIP MID-MESSAGE ----
  {
    name: 'strips: In short, mid-message',
    candidate: "bet. In short, its $200 deposit then payment plan.",
    expect: {
      ok: true,
      notContains: ['In short,'],
      contains: ['$200 deposit'],
      violationsIncludes: ['stripped_ai_summary_label'],
    },
  },
  {
    name: 'allows: "short" as regular word',
    candidate: "yea its a short trip, 4 nights",
    expect: { ok: true, contains: ['short trip'] },
  },

  // ---- STAFF NAMES ----
  {
    name: 'bans: names Vivian',
    candidate: "Vivian from our team can walk you through it",
    expect: { ok: false, reasonIncludes: 'named staff' },
  },
  {
    name: 'bans: names Ashton',
    candidate: "Ashton will send the details",
    expect: { ok: false, reasonIncludes: 'named staff' },
  },
  {
    name: 'bans: names Manuel',
    candidate: "Manuel is our booze cruise rep on the ground",
    expect: { ok: false, reasonIncludes: 'named staff' },
  },
  {
    name: 'bans: names Justin Rodriguez',
    candidate: "Justin Rodriguez is covering that one",
    expect: { ok: false, reasonIncludes: 'named staff' },
  },
  {
    name: 'ALLOWS: generic team reference',
    candidate: "our team on the ground will meet you at the airport",
    expect: { ok: true },
  },

  // ---- DASHES ----
  {
    name: 'strips: em dash replaced with comma',
    candidate: "Cabo is a vibe\u2014def more on the expensive side but worth it.",
    expect: {
      ok: true,
      contains: [', def more'],
      notContains: ['\u2014'],
    },
  },
  {
    name: 'strips: hyphen between words',
    candidate: "We do all-inclusive packages.",
    expect: {
      ok: true,
      notContains: ['all-inclusive'],
      contains: ['all inclusive'],
    },
  },
  {
    name: 'strips: off-resort hyphen',
    candidate: "party pass covers off-resort nightclub events",
    expect: {
      ok: true,
      notContains: ['off-resort'],
      contains: ['off resort'],
    },
  },

  // ---- EMOJI (Spiffy: zero, including opener) ----
  {
    name: 'strips: emoji in non-opener',
    candidate: "word thats where ill be too 🔥",
    isFirstMessage: false,
    expect: { ok: true, notContains: ['🔥'], violationsIncludes: ['stripped_emoji'] },
  },
  {
    name: 'strips: emoji IN opener (Spiffy tightened rule)',
    candidate: "What's good! It's Spiffy from SpringBreak U 🙂",
    isFirstMessage: true,
    expect: { ok: true, notContains: ['🙂'], violationsIncludes: ['stripped_emoji'] },
  },

  // ---- REP NAME NORMALIZATION ----
  {
    name: 'normalizes: Derrick -> Spiffy',
    candidate: "hey this Derrick from SpringBreak U",
    expect: {
      ok: true,
      contains: ['Spiffy'],
      notContains: ['Derrick'],
      violationsIncludes: ['normalized_rep_name'],
    },
  },
  {
    name: 'normalizes: Derrick Darko -> Spiffy',
    candidate: "hey this Derrick Darko from SpringBreak U",
    expect: {
      ok: true,
      contains: ['Spiffy'],
      notContains: ['Derrick', 'Darko'],
    },
  },
  {
    name: 'normalizes: full stage name -> Spiffy',
    candidate: "Derrick Spiffy Darko here, from SpringBreak U",
    expect: {
      ok: true,
      contains: ['Spiffy here'],
      notContains: ['Derrick', 'Darko'],
    },
  },

  // ---- HALLUCINATED RESERVATION LINK ----
  {
    name: 'bans: hallucinated package link with code',
    candidate:
      "here's your link: secure.springbreaku.com/site/public/package/H0ARDLPECS",
    expect: { ok: false, reasonIncludes: 'hallucinated reservation link' },
  },
  {
    name: 'bans: hallucinated package link with https',
    candidate:
      "here you go https://secure.springbreaku.com/site/public/package/ABC123XYZ",
    expect: { ok: false, reasonIncludes: 'hallucinated reservation link' },
  },

  // ---- AI-TELL SOFT-CAPS ----
  {
    name: 'allows: "I understand" once (no prior)',
    candidate: "yea I understand, take your time",
    priorAssistantMessages: [],
    expect: { ok: true },
  },
  {
    name: 'bans: "I understand" second time in thread',
    candidate: "yea I understand, lmk when ready",
    priorAssistantMessages: ["word I understand, just lmk when the group decides"],
    expect: { ok: false, reasonIncludes: 'i_understand' },
  },
  {
    name: 'bans: "I hear you" second time',
    candidate: "I hear you, we can finesse that",
    priorAssistantMessages: ["yea I hear you, all good"],
    expect: { ok: false, reasonIncludes: 'i_hear_you' },
  },
  {
    name: 'bans: "happy to help" second time',
    candidate: "happy to help any way we can",
    priorAssistantMessages: ["happy to help, lemme know"],
    expect: { ok: false, reasonIncludes: 'happy_to_help' },
  },
  {
    name: 'bans: "totally" second time',
    candidate: "totally, thats cool",
    priorAssistantMessages: ["totally, take your time"],
    expect: { ok: false, reasonIncludes: 'totally' },
  },
  {
    name: 'bans: "I feel you" second time',
    candidate: "I feel you, its a lot",
    priorAssistantMessages: ["yea I feel you on the price"],
    expect: { ok: false, reasonIncludes: 'i_feel_you' },
  },
  {
    name: 'allows: "totally" once (no prior use)',
    candidate: "totally up to you if you wanna add it or not",
    priorAssistantMessages: [],
    expect: { ok: true },
  },

  // ---- COMPOUND QUESTIONS (rhetorical-aware) ----
  {
    name: 'bans: two real answer-seeking questions',
    candidate: "which week yall going? how many ppl total?",
    expect: { ok: false, reasonIncludes: 'compound question' },
  },
  {
    name: 'bans: three real questions',
    candidate: "which week? which destination? how many ppl?",
    expect: { ok: false, reasonIncludes: 'compound question' },
  },
  {
    name: 'ALLOWS: rhetorical ? + declarative answer (honest take pattern)',
    candidate: "honest take? Punta Cana all day. Occidental is the move",
    expect: { ok: true, contains: ['honest take?', 'Punta Cana'] },
  },
  {
    name: 'ALLOWS: rhetorical ? + declarative + one real question',
    candidate: "honest take? Punta Cana all day. Occidental is the move. which week yall goin?",
    expect: { ok: true },
  },
  {
    name: 'ALLOWS: permission question + declarative reason',
    candidate: "is it cool if I send through email? its a little long for text",
    expect: { ok: true, contains: ['is it cool if I send through email?'] },
  },
  {
    name: 'ALLOWS: permission question + declarative + next real question',
    candidate: "is it cool if I send through email? its a little long for text. whats your email?",
    expect: { ok: true },
  },
  {
    name: 'allows: single ? with "or" alternatives (Spiffy voice)',
    candidate: "yall down for Riu or Tesoro?",
    expect: { ok: true, contains: ['Riu or Tesoro?'] },
  },
  {
    name: 'allows: single question with preamble',
    candidate: "yea that makes sense. how many ppl in your group?",
    expect: { ok: true },
  },
  {
    name: 'allows: two statements no questions',
    candidate: "cool all good. ill send what we have in mind",
    expect: { ok: true },
  },

  // ---- QUALIFIER REPEAT ----
  {
    name: 'allows: asking week once',
    candidate: "which week is your spring break?",
    priorAssistantMessages: [],
    expect: { ok: true },
  },
  {
    name: 'allows: asking week twice (2nd ask OK)',
    candidate: "hey just circling, which week yall goin?",
    priorAssistantMessages: [
      "What's good! It's Spiffy from SpringBreak U here. Which week is your spring break?",
    ],
    expect: { ok: true },
  },
  {
    name: 'bans: asking week a 3rd time',
    candidate: "which week is your spring break?",
    priorAssistantMessages: [
      "What's good! It's Spiffy from SpringBreak U here. Which week is your spring break?",
      "no rush, but which week were you lookin at?",
    ],
    expect: { ok: false, reasonIncludes: 'qualifier re-ask' },
  },
  {
    name: 'bans: asking school a 3rd time',
    candidate: "which school yall from?",
    priorAssistantMessages: [
      "word. which school you all from?",
      "oh, which school we from?",
    ],
    expect: { ok: false, reasonIncludes: 'qualifier re-ask' },
  },
  {
    name: 'bans: asking group size a 3rd time',
    candidate: "how many ppl in your group?",
    priorAssistantMessages: [
      "how many ppl in your group so far?",
      "how many people total?",
    ],
    expect: { ok: false, reasonIncludes: 'qualifier re-ask' },
  },
  {
    name: 'allows: asking destination once after school twice',
    candidate: "which destination were you lookin to book?",
    priorAssistantMessages: [
      "which school you all from?",
      "where yall from?",
    ],
    expect: { ok: true },
  },

  // ---- WHAT'S ON YOUR RADAR ETC ----
  {
    name: 'bans: whats on your radar',
    candidate: "hey! whats on your radar for spring break?",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: what brings you here',
    candidate: "hey, what brings you here?",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },

  // ---- LOWERCASE STARTS ARE FINE (Spiffy voice) ----
  {
    name: 'allows: lowercase message start',
    candidate: "yea lets do it! ill set up the reservation rn",
    expect: { ok: true, contains: ['yea lets do it'] },
  },
  {
    name: 'allows: bet as first word lowercase',
    candidate: "bet one sec, gonna pull that now",
    expect: { ok: true, contains: ['bet one sec'] },
  },

  // ---- MISSING APOSTROPHES ARE FINE ----
  {
    name: 'allows: thats, ill, im, theres (Spiffy style)',
    candidate: "thats a vibe. ill set it up and send it over. theres only a couple spots left tho",
    expect: { ok: true, contains: ['thats a vibe', 'ill set it up'] },
  },

  // ---- LINK BUDGET ----
  {
    name: 'bans: any URL when budget exhausted',
    candidate: "here you go https://example.com/info",
    linkSendCountBefore: 2,
    expect: { ok: false, reasonIncludes: 'link budget' },
  },
  {
    name: 'allows: URL when budget remaining',
    candidate: "yup here's a flight option https://google.com/flights",
    linkSendCountBefore: 0,
    expect: { ok: true },
  },

  // ---- QUALIFIER-TACK-ON GUARD (soft turns) ----
  {
    name: 'bans: qualifier after "cool thanks"',
    candidate: "bet. which week is your spring break?",
    inboundText: "cool thanks",
    expect: { ok: false, reasonIncludes: 'qualifier tacked onto a soft turn' },
  },
  {
    name: 'bans: qualifier after "let me ask my group"',
    candidate: "word sounds good. lmk what the squad thinks which week yall goin?",
    inboundText: "let me ask my group first",
    expect: { ok: false, reasonIncludes: 'qualifier tacked onto a soft turn' },
  },
  {
    name: 'bans: qualifier after "ok"',
    candidate: "bet. which destination were you lookin to book?",
    inboundText: "ok",
    expect: { ok: false, reasonIncludes: 'qualifier tacked onto a soft turn' },
  },
  {
    name: 'bans: qualifier after "too expensive"',
    candidate: "yea I feel that. $200 deposit locks in the spot. which week is your spring break?",
    inboundText: "thats kinda steep",
    expect: { ok: false, reasonIncludes: 'qualifier tacked onto a soft turn' },
  },
  {
    name: 'bans: qualifier after "is this a scam"',
    candidate: "nah weve been doing this for years. which week is your spring break?",
    inboundText: "is this a scam",
    expect: { ok: false, reasonIncludes: 'qualifier tacked onto a soft turn' },
  },
  {
    name: 'ALLOWS: qualifier after substantive inbound (not soft)',
    candidate: "word thats where ill be too. how many ppl in your group?",
    inboundText: "punta cana for sure",
    expect: { ok: true },
  },
  {
    name: 'ALLOWS: no qualifier on soft turn (just response)',
    candidate: "word sounds good. lmk what the squad thinks",
    inboundText: "let me ask my group",
    expect: { ok: true },
  },
  {
    name: 'ALLOWS: short reply on soft turn',
    candidate: "bet",
    inboundText: "ok cool",
    expect: { ok: true },
  },

  // ---- APOSTROPHE DENSITY ----
  {
    name: 'rewrites: too many apostrophes softened',
    candidate: "I'll send it over, it's the best deal and that's where I'm headed too",
    expect: {
      ok: true,
      violationsIncludes: ['softened_apostrophes'],
    },
  },
  {
    name: 'allows: already casual (no apostrophes to fix)',
    candidate: "ill send it over, its the best deal and thats where im headed too",
    expect: { ok: true },
  },

  // ---- RHYTHM VARIANCE ----
  {
    name: 'bans: 3 replies in a row at same length',
    candidate: "yea it depends on how many ppl and which destination you want to go",
    priorAssistantLengths: [68, 72],
    expect: { ok: false, reasonIncludes: 'rhythm is too uniform' },
  },
  {
    name: 'ALLOWS: varied lengths (short after two medium)',
    candidate: "bet",
    priorAssistantLengths: [68, 72],
    expect: { ok: true },
  },
  {
    name: 'ALLOWS: all short (under 60 chars, natural)',
    candidate: "word sounds good",
    priorAssistantLengths: [12, 18],
    expect: { ok: true },
  },

  // ---- APOLOGY+REPLAY BAN (LLMD V3 port) ----
  {
    name: 'bans: sorry about that lemme try again',
    candidate: "sorry about that, lemme try again",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: sorry my last message got scrambled',
    candidate: "sorry, my last message got scrambled",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: sorry that got cut off',
    candidate: "sorry that got cut off, here it is again",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: what I said earlier wasnt right, my last message',
    candidate: "what I said earlier wasn't quite right, my last message had the wrong info",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: let me try that again',
    candidate: "let me try that again",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: ok let me try that',
    candidate: "ok let me try that",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: to recap what I said',
    candidate: "to recap what I said, the deposit is $200",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: ha that scrambled',
    candidate: "ha that scrambled, here's the real answer",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: my reply glitched',
    candidate: "my reply glitched, Punta Cana is the move",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: got cut off on my end',
    candidate: "got cut off on my end, anyway the deposit is $200",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'bans: something went wrong on my end',
    candidate: "something went wrong on my end, lemme resend",
    expect: { ok: false, reasonIncludes: 'banned phrase' },
  },
  {
    name: 'ALLOWS: sorry youre dealing with that (not tech apology)',
    candidate: "sorry youre dealing with that, which week works best for your group?",
    expect: { ok: true },
  },
  {
    name: 'ALLOWS: my last trip there was wild (not apology+replay)',
    candidate: "my last trip there was wild, Punta Cana all day",
    expect: { ok: true },
  },

  // ---- LENGTH CAP ----
  {
    name: 'allows: 3-sentence Spiffy reply under cap',
    candidate:
      "yea I feel that. $200 locks in the spot then the rest spreads over a couple weeks. want me to send the breakdown?",
    expect: { ok: true },
  },
  {
    name: 'trims: 5-sentence message preserving bridge',
    candidate:
      "Validation sentence here. Middle one with specific number $200. Middle two more detail about payment. Middle three about group setup. want me to send the breakdown so you can look it over in detail?",
    expect: { ok: true, contains: ['Validation', 'want me to send the breakdown'] },
  },
];

function check(c: Case): { passed: boolean; detail: string } {
  const res = applyGuardrail({
    candidate: c.candidate,
    linkSendCountBefore: c.linkSendCountBefore ?? 0,
    isFirstMessage: c.isFirstMessage ?? false,
    priorAssistantMessages: c.priorAssistantMessages,
    inboundText: c.inboundText,
    priorAssistantLengths: c.priorAssistantLengths,
  });

  if (c.expect.ok) {
    if (!res.ok) return { passed: false, detail: `expected ok, got reject: ${res.reason}` };
    for (const s of c.expect.contains ?? []) {
      if (!res.clean.includes(s))
        return { passed: false, detail: `clean missing "${s}". clean="${res.clean}"` };
    }
    for (const s of c.expect.notContains ?? []) {
      if (res.clean.includes(s))
        return { passed: false, detail: `clean contained "${s}". clean="${res.clean}"` };
    }
    for (const v of c.expect.violationsIncludes ?? []) {
      if (!res.violations.includes(v))
        return {
          passed: false,
          detail: `violations missing "${v}". got=${JSON.stringify(res.violations)}`,
        };
    }
    return { passed: true, detail: '' };
  } else {
    if (res.ok) return { passed: false, detail: `expected reject, got ok. clean="${res.clean}"` };
    if (!res.reason.toLowerCase().includes(c.expect.reasonIncludes.toLowerCase())) {
      return { passed: false, detail: `reason missing "${c.expect.reasonIncludes}". got="${res.reason}"` };
    }
    return { passed: true, detail: '' };
  }
}

function main() {
  let passed = 0;
  let failed = 0;
  for (const c of CASES) {
    const r = check(c);
    if (r.passed) {
      passed += 1;
      console.log(`PASS  ${c.name}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${c.name}`);
      console.log(`      ${r.detail}`);
    }
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

main();
