/**
 * Unit tests for the debounce ("wait step") DO logic + hot-lead detector.
 * Run: npx tsx worker/src/memory/debounce.test.ts
 *
 * Mocks DurableObjectState.storage (incl. alarms) and a fresh ContactThread
 * per logical invocation so we exercise the real load()/save() persistence.
 *
 * Covers the post-review redesign: claim-all PEEKS (leaves the burst queued)
 * and arms a recovery alarm; /mark-processed rings ids right after send;
 * /finish-drain prunes answered ids; alarm() re-arms a recovery check while a
 * drain runs and re-drives a STALE (crashed) drain — so a crash never ghosts.
 */
import { ContactThread } from './ContactThread';
import { isHotLead } from '../routes/webhook';

// ---- mock storage (shared across "invocations") ----
function makeStorage() {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    async get(k: string) {
      const v = map.get(k);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(k: string, v: unknown) {
      map.set(k, structuredClone(v));
    },
    async delete(k: string) {
      map.delete(k);
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(t: number) {
      alarm = t;
    },
    async deleteAlarm() {
      alarm = null;
    },
    _alarm() {
      return alarm;
    },
    _setAlarmRaw(t: number | null) {
      alarm = t;
    },
  };
}

const ENV: any = {
  WORKER_SELF_URL: 'https://worker.test',
  INTERNAL_DRAIN_SECRET: 'sekret',
};

function freshCT(storage: any) {
  return new ContactThread({ storage } as any, ENV);
}

async function call(storage: any, path: string, body?: unknown) {
  const ct = freshCT(storage);
  const res = await ct.fetch(
    new Request(`https://do${path}`, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { status: res.status, json };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`[PASS] ${name}`);
    pass++;
  } else {
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

async function init(storage: any, contactId = 'c1') {
  await call(storage, '/init', { contactId });
}

// drive the alarm() handler with a recording fetch; returns # of handoff calls
async function fireAlarm(storage: any) {
  const calls: Array<{ url: string; secret: string | null; body: any }> = [];
  const orig = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, opts: any) => {
    calls.push({
      url: String(url),
      secret: opts?.headers?.['x-internal-drain-secret'] ?? null,
      body: opts?.body ? JSON.parse(opts.body) : null,
    });
    return new Response(JSON.stringify({ ack: true }), { status: 200 });
  };
  try {
    const ct = freshCT(storage);
    await (ct as any).alarm();
  } finally {
    (globalThis as any).fetch = orig;
  }
  return calls;
}

async function run() {
  // ---------- isHotLead ----------
  check('hot: "send me the link"', isHotLead('yo send me the link'));
  check('hot: "lets do it"', isHotLead('ok lets do it'));
  check('hot: "im in"', isHotLead("im in fr"));
  check('hot: email present', isHotLead('here john@example.com'));
  check('hot: "how do i pay"', isHotLead('how do i pay'));
  check('cold: "which hotel is best"', !isHotLead('which hotel is best'));
  check('cold: "second week of march"', !isHotLead('second week of march punta cana'));
  check('cold: empty', !isHotLead(''));

  // ---------- enqueue arms alarm + increments pending ----------
  {
    const s = makeStorage();
    await init(s);
    const r1 = await call(s, '/enqueue', { messageId: 'm1', body: 'yo', receivedAt: 1000 });
    check('enqueue: first returns enqueued', r1.json?.enqueued === true, JSON.stringify(r1.json));
    check('enqueue: pendingCount=1', r1.json?.pendingCount === 1);
    check('enqueue: alarm armed', s._alarm() !== null);
    check('enqueue: cold fireInMs within cap', r1.json?.fireInMs >= 9000 && r1.json?.fireInMs <= 10500, `fireInMs=${r1.json?.fireInMs}`);
    const r2 = await call(s, '/enqueue', { messageId: 'm2', body: 'whats up', receivedAt: 1100 });
    check('enqueue: second pendingCount=2', r2.json?.pendingCount === 2);
  }

  // ---------- enqueue dedup ----------
  {
    const s = makeStorage();
    await init(s);
    await call(s, '/enqueue', { messageId: 'dup', body: 'a', receivedAt: 1 });
    const r = await call(s, '/enqueue', { messageId: 'dup', body: 'a', receivedAt: 2 });
    check('enqueue: duplicate id rejected', r.json?.duplicate === true, JSON.stringify(r.json));
  }

  // ---------- hot enqueue collapses window ----------
  {
    const s = makeStorage();
    await init(s);
    const r = await call(s, '/enqueue', { messageId: 'h1', body: 'send me the link', receivedAt: 1, hot: true });
    check('enqueue: hot fireInMs <=1500', r.json?.fireInMs <= 1500, `fireInMs=${r.json?.fireInMs}`);
    check('enqueue: hot flagged', r.json?.hot === true);
    const r2 = await call(s, '/enqueue', { messageId: 'h2', body: 'punta cana', receivedAt: 2 });
    check('enqueue: hot latched keeps window short', r2.json?.fireInMs <= 1500, `fireInMs=${r2.json?.fireInMs}`);
  }

  // ---------- claim-all PEEKS (does not clear pending), sets draining, arms recovery ----------
  {
    const s = makeStorage();
    await init(s);
    await call(s, '/enqueue', { messageId: 'a', body: 'first', receivedAt: 200 });
    await call(s, '/enqueue', { messageId: 'b', body: 'second', receivedAt: 100 }); // earlier
    const r = await call(s, '/claim-all');
    check('claim-all: claimed', r.json?.claimed === true, JSON.stringify(r.json));
    check('claim-all: 2 messages', r.json?.messagesToProcess?.length === 2);
    check('claim-all: sorted by receivedAt', r.json?.messagesToProcess?.[0]?.messageId === 'b');
    const st = await call(s, '/get');
    check('claim-all: PEEK — pending NOT cleared', (st.json?.pendingMessages?.length ?? 0) === 2);
    check('claim-all: draining=true', st.json?.draining === true);
    check('claim-all: recovery alarm armed', s._alarm() !== null);
    const r2 = await call(s, '/claim-all');
    check('claim-all: blocked while draining', r2.json?.claimed === false && r2.json?.reason === 'draining', JSON.stringify(r2.json));
  }

  // ---------- claim-all empty → claimed false, cancels alarm ----------
  {
    const s = makeStorage();
    await init(s);
    s._setAlarmRaw(123); // pretend an alarm was set
    const r = await call(s, '/claim-all');
    check('claim-all: empty → claimed false reason empty', r.json?.claimed === false && r.json?.reason === 'empty');
    check('claim-all: empty cancels alarm', s._alarm() === null);
  }

  // ---------- claim-all filters already-ringed ids ----------
  {
    const s = makeStorage();
    await init(s);
    await call(s, '/enqueue', { messageId: 'sent1', body: 'x', receivedAt: 1 });
    await call(s, '/mark-processed', { processedMessageIds: ['sent1'] }); // simulate sent
    await call(s, '/enqueue', { messageId: 'new2', body: 'y', receivedAt: 2 });
    const r = await call(s, '/claim-all');
    const ids = (r.json?.messagesToProcess ?? []).map((m: any) => m.messageId);
    check('claim-all: filters already-ringed id', !ids.includes('sent1') && ids.includes('new2'), JSON.stringify(ids));
  }

  // ---------- mark-processed rings ids + is idempotent ----------
  {
    const s = makeStorage();
    await init(s);
    const r = await call(s, '/mark-processed', { processedMessageIds: ['p1', 'p2'] });
    check('mark-processed: rings 2', r.json?.ringed === 2);
    const st = await call(s, '/get');
    check('mark-processed: in ring', st.json?.recentInboundIds?.includes('p1') && st.json?.recentInboundIds?.includes('p2'));
    const r2 = await call(s, '/mark-processed', { processedMessageIds: ['p1'] }); // dup
    check('mark-processed: idempotent (no dup in ring)', (await call(s, '/get')).json?.recentInboundIds?.filter((x: string) => x === 'p1').length === 1, JSON.stringify(r2.json));
  }

  // ---------- finish-drain prunes answered + re-arms only for genuinely new ----------
  {
    const s = makeStorage();
    await init(s);
    await call(s, '/enqueue', { messageId: 'p1', body: 'x', receivedAt: 1 });
    await call(s, '/claim-all'); // peek: p1 stays, draining=true
    await call(s, '/mark-processed', { processedMessageIds: ['p1'] }); // simulate send
    await call(s, '/enqueue', { messageId: 'p2', body: 'late', receivedAt: 2 }); // arrived during drain
    const r = await call(s, '/finish-drain');
    check('finish-drain: re-armed for new text', r.json?.rearmed === true, JSON.stringify(r.json));
    const st = await call(s, '/get');
    check('finish-drain: answered p1 pruned', !(st.json?.pendingMessages ?? []).some((p: any) => p.messageId === 'p1'));
    check('finish-drain: new p2 retained', (st.json?.pendingMessages ?? []).some((p: any) => p.messageId === 'p2'));
    check('finish-drain: draining cleared', st.json?.draining === false);
    check('finish-drain: alarm re-armed', s._alarm() !== null);
  }
  {
    const s = makeStorage();
    await init(s);
    await call(s, '/enqueue', { messageId: 'p1', body: 'x', receivedAt: 1 });
    await call(s, '/claim-all');
    await call(s, '/mark-processed', { processedMessageIds: ['p1'] });
    const r = await call(s, '/finish-drain'); // nothing new
    check('finish-drain: no re-arm when all answered', r.json?.rearmed === false);
    check('finish-drain: queue empty', ((await call(s, '/get')).json?.pendingMessages?.length ?? 0) === 0);
    check('finish-drain: alarm cancelled when empty', s._alarm() === null);
  }

  // ---------- drop-pending ----------
  {
    const s = makeStorage();
    await init(s);
    await call(s, '/enqueue', { messageId: 'd1', body: 'x', receivedAt: 1 });
    const r = await call(s, '/drop-pending');
    check('drop-pending: ok', r.json?.dropped === true);
    const st = await call(s, '/get');
    check('drop-pending: pending cleared', (st.json?.pendingMessages?.length ?? 0) === 0);
    check('drop-pending: alarm cancelled', s._alarm() === null);
  }

  // ---------- alarm() self-fetch handoff ----------
  {
    const s = makeStorage();
    await init(s);
    await call(s, '/enqueue', { messageId: 'al1', body: 'x', receivedAt: 1 });
    const calls = await fireAlarm(s);
    check('alarm: handoff fired once', calls.length === 1, `calls=${calls.length}`);
    check('alarm: hits /internal/drain', calls[0]?.url.endsWith('/internal/drain'));
    check('alarm: sends secret', calls[0]?.secret === 'sekret');
    check('alarm: passes contactId', calls[0]?.body?.contactId === 'c1');
  }

  // ---------- alarm() no-op when pending empty ----------
  {
    const s = makeStorage();
    await init(s);
    const calls = await fireAlarm(s);
    check('alarm: no handoff when queue empty', calls.length === 0);
  }

  // ---------- alarm() while drain running (not stale) → no handoff, arms recovery ----------
  {
    const s = makeStorage();
    await init(s);
    await call(s, '/enqueue', { messageId: 'x1', body: 'x', receivedAt: 1 });
    await call(s, '/claim-all'); // draining=true, inFlightSince=now
    await call(s, '/enqueue', { messageId: 'x2', body: 'y', receivedAt: 2 });
    const calls = await fireAlarm(s);
    check('alarm: skips handoff while fresh drain running', calls.length === 0);
    check('alarm: armed a recovery check', s._alarm() !== null);
  }

  // ---------- alarm() RECOVERY: stale drain + still-queued burst → re-drives ----------
  {
    const s = makeStorage();
    await init(s);
    await call(s, '/enqueue', { messageId: 'g1', body: 'help', receivedAt: 1 });
    await call(s, '/claim-all'); // peek: g1 stays, draining=true
    // simulate the detached drain CRASHING before finish-drain: force the lock
    // to look stale by rewriting inFlightSince far into the past.
    {
      const st = (await call(s, '/get')).json;
      st.inFlightSince = 1; // ancient → stale
      await s.put('state', st);
    }
    const calls = await fireAlarm(s);
    check('alarm: recovers stale drain (re-hands-off)', calls.length === 1, `calls=${calls.length}`);
    check('alarm: recovery passes contactId', calls[0]?.body?.contactId === 'c1');
    // and the burst is still in the queue (never lost)
    check('alarm: burst still queued for recovery', ((await call(s, '/get')).json?.pendingMessages?.length ?? 0) === 1);
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

run();
