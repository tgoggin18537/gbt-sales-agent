/**
 * Deterministic classifier tests for classifyConversationContext.
 *
 * Zero external calls — mocks globalThis.fetch to return canned GHL
 * responses. Covers the 5 discriminated-union kinds + boundary cases
 * at exactly 6h dormancy, exactly 30min race window, and exactly at
 * the 600s outbound-detection cutoff.
 *
 * Run:
 *   npx tsx worker/src/integrations/ghl.test.ts
 */

import { classifyConversationContext, type ClassifierResult } from './ghl';

type Msg = {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  dateAdded: string;
  userId?: string;
  source?: string;
};

const env = { locationId: 'loc_1', apiKey: 'k_test' };
const NOW = 1_700_000_000_000;

function mockGhl(messages: Msg[]) {
  // Newest-first is the GHL contract; preserve whatever order the test gives.
  globalThis.fetch = (async (url: string | URL | Request, _init?: any) => {
    const u = String(typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url);
    if (u.includes('/conversations/search')) {
      return new Response(JSON.stringify({ conversations: [{ id: 'c1' }] }), { status: 200 });
    }
    if (u.includes('/conversations/c1/messages')) {
      return new Response(JSON.stringify({ messages }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as any;
}

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const min = (n: number) => n * 60_000;
const hr = (n: number) => n * 3_600_000;

// Pin Date.now() so tests are deterministic.
const realDateNow = Date.now;
Date.now = () => NOW;

type Case = {
  name: string;
  messages: Msg[];
  botIds: string[];
  currentInboundId: string | null;
  assert: (result: ClassifierResult, diagDecision: string) => string[] | null;
};

const cases: Case[] = [
  // ---- KIND COVERAGE ----
  {
    name: 'fresh: DO empty + workflow opener visible → kind=fresh, openerLikelySent=true',
    messages: [
      { id: 'in_1', direction: 'inbound', body: 'yo whats up', dateAdded: iso(min(1)) },
      { id: 'wf_op', direction: 'outbound', body: "What's good! Spiffy from SpringBreak U here", dateAdded: iso(min(5)) },
    ],
    botIds: [],
    currentInboundId: 'in_1',
    assert: (r) => {
      const fails: string[] = [];
      if (r.kind !== 'fresh') fails.push(`kind=${r.kind} expected fresh`);
      else {
        if (!r.openerLikelySent) fails.push('openerLikelySent should be true');
        if (r.linkAlreadySent) fails.push('linkAlreadySent should be false');
        if (r.history.length !== 1) fails.push(`history length ${r.history.length} expected 1`);
        if (r.history[0]?.role !== 'assistant') fails.push('history[0].role should be assistant');
      }
      return fails.length ? fails : null;
    },
  },
  {
    name: 'fresh: DO empty + no prior msgs → kind=fresh, history empty, openerLikelySent=false',
    messages: [{ id: 'in_1', direction: 'inbound', body: 'hello', dateAdded: iso(min(0)) }],
    botIds: [],
    currentInboundId: 'in_1',
    assert: (r) => {
      const fails: string[] = [];
      if (r.kind !== 'fresh') fails.push(`kind=${r.kind} expected fresh`);
      else {
        if (r.history.length !== 0) fails.push(`history length ${r.history.length} expected 0`);
        if (r.openerLikelySent) fails.push('openerLikelySent should be false');
      }
      return fails.length ? fails : null;
    },
  },
  {
    name: 'clean: bot engaged + no interveners in window',
    messages: [
      { id: 'in_2', direction: 'inbound', body: 'march 6', dateAdded: iso(min(2)) },
      { id: 'bot_1', direction: 'outbound', body: 'which week?', dateAdded: iso(min(4)) },
    ],
    botIds: ['bot_1'],
    currentInboundId: 'in_2',
    assert: (r) => (r.kind === 'clean' ? null : [`kind=${r.kind} expected clean`]),
  },
  {
    name: 'workflow_catchup: bot dormant 12h + drip 5min ago → kind=workflow_catchup',
    messages: [
      { id: 'in_3', direction: 'inbound', body: 'still around?', dateAdded: iso(min(1)) },
      { id: 'drip_1', direction: 'outbound', body: 'just checking back in!', dateAdded: iso(min(5)) },
      { id: 'bot_old', direction: 'outbound', body: 'bet talk soon', dateAdded: iso(hr(12)) },
    ],
    botIds: ['bot_old'],
    currentInboundId: 'in_3',
    assert: (r) => {
      const fails: string[] = [];
      if (r.kind !== 'workflow_catchup') fails.push(`kind=${r.kind} expected workflow_catchup`);
      else {
        if (r.linkAlreadySent) fails.push('linkAlreadySent should be false');
        if (!r.history.some((h) => h.content === 'just checking back in!')) {
          fails.push('history should include drip');
        }
      }
      return fails.length ? fails : null;
    },
  },
  {
    name: 'workflow_catchup with booking link → linkAlreadySent=true',
    messages: [
      { id: 'in_4', direction: 'inbound', body: 'got it', dateAdded: iso(min(1)) },
      {
        id: 'drip_link',
        direction: 'outbound',
        body: 'heres your link https://secure.springbreaku.com/site/public/package/ABC123 lmk',
        dateAdded: iso(min(5)),
      },
      { id: 'bot_old', direction: 'outbound', body: 'bet', dateAdded: iso(hr(12)) },
    ],
    botIds: ['bot_old'],
    currentInboundId: 'in_4',
    assert: (r) => {
      if (r.kind !== 'workflow_catchup') return [`kind=${r.kind} expected workflow_catchup`];
      return r.linkAlreadySent ? null : ['linkAlreadySent should be true'];
    },
  },
  {
    name: 'workflow_catchup with lowercase package id → linkAlreadySent=true (P1-4 widened regex)',
    messages: [
      { id: 'in_4l', direction: 'inbound', body: 'got it', dateAdded: iso(min(1)) },
      {
        id: 'drip_link',
        direction: 'outbound',
        body: 'check this https://secure.springbreaku.com/site/public/package/abc123def',
        dateAdded: iso(min(5)),
      },
      { id: 'bot_old', direction: 'outbound', body: 'bet', dateAdded: iso(hr(12)) },
    ],
    botIds: ['bot_old'],
    currentInboundId: 'in_4l',
    assert: (r) => {
      if (r.kind !== 'workflow_catchup') return [`kind=${r.kind} expected workflow_catchup`];
      return r.linkAlreadySent ? null : ['linkAlreadySent should be true on lowercase package code'];
    },
  },
  {
    name: 'workflow_race: bot sent 1min ago + new outbound 5min ago → kind=workflow_race',
    messages: [
      { id: 'in_5', direction: 'inbound', body: 'cool', dateAdded: iso(min(0.5)) },
      { id: 'bot_recent', direction: 'outbound', body: 'bet', dateAdded: iso(min(1)) },
      { id: 'rep_msg', direction: 'outbound', body: 'hey its sarah jumping in', dateAdded: iso(min(5)) },
    ],
    botIds: ['bot_recent'],
    currentInboundId: 'in_5',
    assert: (r) => (r.kind === 'workflow_race' ? null : [`kind=${r.kind} expected workflow_race`]),
  },
  {
    // To hit the ambiguous middle band (manual_takeover), the intervener
    // must be INSIDE the 600s window AND bot must be inside the >30min/<6h
    // gap. Intervener at 5min, bot at 2h → 115min apart (>30min, <6h).
    name: 'manual_takeover: bot sent 2h ago + outbound 5min ago (ambiguous middle band)',
    messages: [
      { id: 'in_6', direction: 'inbound', body: 'thx', dateAdded: iso(min(1)) },
      { id: 'rep_msg', direction: 'outbound', body: 'sarah here, want me to call?', dateAdded: iso(min(5)) },
      { id: 'bot_2h', direction: 'outbound', body: 'lmk', dateAdded: iso(hr(2)) },
    ],
    botIds: ['bot_2h'],
    currentInboundId: 'in_6',
    assert: (r) => (r.kind === 'manual_takeover' ? null : [`kind=${r.kind} expected manual_takeover`]),
  },

  // ---- BOUNDARIES ----
  {
    name: 'boundary: bot dormant exactly 6h + intervener → NOT catchup (strict >)',
    messages: [
      { id: 'in_b1', direction: 'inbound', body: 'hey', dateAdded: iso(min(1)) },
      { id: 'rep', direction: 'outbound', body: 'jumping in', dateAdded: iso(min(5)) },
      { id: 'bot_6h', direction: 'outbound', body: 'bet', dateAdded: iso(hr(6)) },
    ],
    botIds: ['bot_6h'],
    currentInboundId: 'in_b1',
    assert: (r) =>
      r.kind === 'manual_takeover' ? null : [`kind=${r.kind} expected manual_takeover (exactly 6h not strict-greater)`],
  },
  {
    name: 'boundary: bot dormant 6h + 1ms → kind=workflow_catchup',
    messages: [
      { id: 'in_b2', direction: 'inbound', body: 'hey', dateAdded: iso(min(1)) },
      { id: 'drip', direction: 'outbound', body: 'checking back', dateAdded: iso(min(5)) },
      { id: 'bot_old', direction: 'outbound', body: 'bet', dateAdded: iso(hr(6) + 1) },
    ],
    botIds: ['bot_old'],
    currentInboundId: 'in_b2',
    assert: (r) =>
      r.kind === 'workflow_catchup' ? null : [`kind=${r.kind} expected workflow_catchup at 6h+1ms`],
  },
  {
    name: 'boundary: intervener exactly 30min from bot send → NOT race (strict <)',
    messages: [
      { id: 'in_b3', direction: 'inbound', body: 'ok', dateAdded: iso(min(1)) },
      { id: 'rep', direction: 'outbound', body: 'sarah here', dateAdded: iso(min(5)) },
      { id: 'bot_35', direction: 'outbound', body: 'bet', dateAdded: iso(min(35)) },
    ],
    botIds: ['bot_35'],
    currentInboundId: 'in_b3',
    assert: (r) =>
      r.kind === 'manual_takeover' ? null : [`kind=${r.kind} expected manual_takeover (30min exact = not strict-less)`],
  },
  {
    name: 'boundary: intervener 29min from bot send → kind=workflow_race',
    messages: [
      { id: 'in_b4', direction: 'inbound', body: 'ok', dateAdded: iso(min(1)) },
      { id: 'rep', direction: 'outbound', body: 'sarah here', dateAdded: iso(min(5)) },
      { id: 'bot_34', direction: 'outbound', body: 'bet', dateAdded: iso(min(34)) },
    ],
    botIds: ['bot_34'],
    currentInboundId: 'in_b4',
    assert: (r) => (r.kind === 'workflow_race' ? null : [`kind=${r.kind} expected workflow_race`]),
  },
  {
    // Code uses `if (t < cutoff) continue;` — strict less-than. A message
    // at EXACTLY the cutoff (t === cutoff) is NOT skipped, so it's
    // considered inside the window. Pins this semantic so a future
    // refactor flipping `<` to `<=` fails loudly.
    name: 'boundary: intervener exactly at window cutoff (600s) → INSIDE window (strict <)',
    messages: [
      { id: 'in_b5', direction: 'inbound', body: 'hey', dateAdded: iso(min(1)) },
      { id: 'rep_edge', direction: 'outbound', body: 'edge rep msg', dateAdded: iso(600_000) },
      { id: 'bot_x', direction: 'outbound', body: 'bet', dateAdded: iso(min(3)) },
    ],
    botIds: ['bot_x'],
    currentInboundId: 'in_b5',
    // bot was 3min ago, intervener at 10min ago (cutoff) → ~7min apart,
    // < 30min → workflow_race.
    assert: (r) =>
      r.kind === 'workflow_race'
        ? null
        : [`kind=${r.kind} expected workflow_race (intervener exactly at cutoff is in window)`],
  },
  {
    // Pin the opposite side: anything strictly older than the cutoff is
    // skipped → no interveners → clean.
    name: 'boundary: intervener 1ms older than cutoff → outside window → kind=clean',
    messages: [
      { id: 'in_b5b', direction: 'inbound', body: 'hey', dateAdded: iso(min(1)) },
      { id: 'rep_old', direction: 'outbound', body: 'very old rep msg', dateAdded: iso(600_001) },
      { id: 'bot_x2', direction: 'outbound', body: 'bet', dateAdded: iso(min(3)) },
    ],
    botIds: ['bot_x2'],
    currentInboundId: 'in_b5b',
    assert: (r) => (r.kind === 'clean' ? null : [`kind=${r.kind} expected clean (intervener strictly outside)`]),
  },
  {
    name: 'fresh: current inbound excluded from history even when echoed in GHL fetch',
    messages: [
      { id: 'cur_in', direction: 'inbound', body: 'this is the current one', dateAdded: iso(min(0)) },
      { id: 'prev_in', direction: 'inbound', body: 'earlier inbound', dateAdded: iso(min(3)) },
    ],
    botIds: [],
    currentInboundId: 'cur_in',
    assert: (r) => {
      if (r.kind !== 'fresh') return [`kind=${r.kind} expected fresh`];
      const contents = r.history.map((h) => h.content);
      return contents.length === 1 && contents[0] === 'earlier inbound'
        ? null
        : [`history contents ${JSON.stringify(contents)} expected [earlier inbound]`];
    },
  },

  // ---- P1-3 REGRESSION: long convo, bot sends fall off window ----
  {
    name: 'P1-3: botGhlMessageIds non-empty but botLastSendAt null (chatty convo) → kind=clean (trust DO)',
    messages: [
      // 20 recent inbound/outbound, none of which are from the bot's tracked set
      ...Array.from({ length: 19 }, (_, i) => ({
        id: `msg_${i}`,
        direction: (i % 2 === 0 ? 'inbound' : 'outbound') as 'inbound' | 'outbound',
        body: `m${i}`,
        dateAdded: iso(min(i)),
      })),
      { id: 'rep_recent', direction: 'outbound' as const, body: 'jumping in', dateAdded: iso(min(2)) },
    ],
    botIds: ['bot_way_back_in_time_not_in_recent_20'],
    currentInboundId: null,
    assert: (r) => (r.kind === 'clean' ? null : [`kind=${r.kind} expected clean when botLastSendAt is null`]),
  },
];

async function run() {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    mockGhl(c.messages);
    try {
      const { result, diagnostic } = await classifyConversationContext(
        env,
        'c_1',
        new Set(c.botIds),
        c.currentInboundId,
      );
      const fails = c.assert(result, diagnostic.decision);
      if (fails === null) {
        console.log(`[PASS] ${c.name}`);
        passed++;
      } else {
        console.log(`[FAIL] ${c.name}`);
        for (const f of fails) console.log(`   - ${f}`);
        console.log(`   actual.kind=${result.kind}  decision=${diagnostic.decision}`);
        failed++;
      }
    } catch (e: any) {
      console.log(`[ERROR] ${c.name}: ${e?.message ?? e}`);
      failed++;
    }
  }
  // Restore Date.now so subsequent code (if any) isn't broken.
  Date.now = realDateNow;
  console.log(`\n${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

run();
