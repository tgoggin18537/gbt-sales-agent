/**
 * GoHighLevel API client (minimum needed surface).
 *
 * Docs: https://highlevel.stoplight.io/docs/integrations
 *
 * We only use: send SMS, add/remove tags, read contact, read recent
 * messages (to detect manual team messages), create internal note,
 * send internal notification.
 */

export type GhlEnv = {
  locationId: string;
  apiKey: string; // Location API key or Private Integration token
  baseUrl?: string;
};

const DEFAULT_BASE = 'https://services.leadconnectorhq.com';

function headers(env: GhlEnv) {
  return {
    Authorization: `Bearer ${env.apiKey}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

export async function sendSms(
  env: GhlEnv,
  params: { contactId: string; message: string },
): Promise<{ messageId: string }> {
  const res = await fetch(`${env.baseUrl ?? DEFAULT_BASE}/conversations/messages`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      type: 'SMS',
      contactId: params.contactId,
      message: params.message,
    }),
  });
  if (!res.ok) throw new Error(`GHL sendSms ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return { messageId: data.messageId ?? data.id };
}

export async function getContact(env: GhlEnv, contactId: string): Promise<any> {
  const res = await fetch(`${env.baseUrl ?? DEFAULT_BASE}/contacts/${contactId}`, {
    headers: headers(env),
  });
  if (!res.ok) throw new Error(`GHL getContact ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.contact ?? data;
}

export async function addTag(env: GhlEnv, contactId: string, tag: string): Promise<void> {
  const res = await fetch(`${env.baseUrl ?? DEFAULT_BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ tags: [tag] }),
  });
  if (!res.ok) throw new Error(`GHL addTag ${res.status}: ${await res.text()}`);
}

export async function removeTag(env: GhlEnv, contactId: string, tag: string): Promise<void> {
  const res = await fetch(`${env.baseUrl ?? DEFAULT_BASE}/contacts/${contactId}/tags`, {
    method: 'DELETE',
    headers: headers(env),
    body: JSON.stringify({ tags: [tag] }),
  });
  if (!res.ok) throw new Error(`GHL removeTag ${res.status}: ${await res.text()}`);
}

/** Recent messages on the contact's conversation, newest first. */
export async function getRecentMessages(
  env: GhlEnv,
  contactId: string,
  limit = 20,
): Promise<Array<{ id: string; direction: 'inbound' | 'outbound'; body: string; dateAdded: string; userId?: string; source?: string }>> {
  // Resolve conversation id
  const convRes = await fetch(
    `${env.baseUrl ?? DEFAULT_BASE}/conversations/search?locationId=${env.locationId}&contactId=${contactId}`,
    { headers: headers(env) },
  );
  if (!convRes.ok) return [];
  const conv = (await convRes.json()) as any;
  const conversationId = conv.conversations?.[0]?.id;
  if (!conversationId) return [];

  const msgRes = await fetch(
    `${env.baseUrl ?? DEFAULT_BASE}/conversations/${conversationId}/messages?limit=${limit}`,
    { headers: headers(env) },
  );
  if (!msgRes.ok) return [];
  const data = (await msgRes.json()) as any;
  return (data.messages?.messages ?? data.messages ?? []).map((m: any) => ({
    id: m.id,
    direction: m.direction,
    body: m.body ?? m.message ?? '',
    dateAdded: m.dateAdded,
    userId: m.userId,
    source: m.source,
  }));
}

/**
 * Detect if a team member has sent a manual outbound SMS recently. If so,
 * Mia should stay silent.
 *
 * Ground truth: every time Mia sends, we persist the returned GHL messageId
 * in the Durable Object. Any outbound in the window whose id is NOT in that
 * set was sent by a human from the inbox (or another workflow).
 *
 * We deliberately do not rely on the GHL `source` field because the
 * /conversations/messages API doesn't let us stamp a custom source on a send,
 * so everything Mia sends looks identical to a manual inbox send.
 *
 * NOTE (June 16): superseded by `classifyConversationContext` below.
 * Kept temporarily for backwards-compat in case any caller hasn't been
 * migrated. Remove once webhook.ts is fully on the classifier.
 */
export async function wasManualOutboundRecent(
  env: GhlEnv,
  contactId: string,
  botGhlMessageIds: Set<string>,
  windowSeconds = 600,
): Promise<boolean> {
  const msgs = await getRecentMessages(env, contactId, 20);
  const cutoff = Date.now() - windowSeconds * 1000;
  return msgs.some(
    (m) =>
      m.direction === 'outbound' &&
      new Date(m.dateAdded).getTime() > cutoff &&
      !botGhlMessageIds.has(m.id),
  );
}

/**
 * Conversation context classifier (June 16 design upgrade).
 *
 * Replaces the binary `wasManualOutboundRecent` with a five-state discriminator
 * that distinguishes fresh contacts, workflow drips, workflow races, and real
 * manual takeovers. Returns enough context for the caller to inject prior
 * messages into Claude's history, bump the booking-link send budget, and apply
 * the right tags.
 *
 * Design notes:
 *
 * - Time-since-bot-last-send is the PRIMARY signal. The GHL `source` and
 *   `userId` fields are logged but not (yet) trusted, because the existing
 *   integration comment notes that bot API sends look identical to manual
 *   inbox sends on `source`. Once we have a week of production logs we can
 *   harden the classifier on real field values. Until then, time is the
 *   most reliable discriminator: real reps don't sit and reply to a 6-hour-
 *   old stale thread, and they almost never type within seconds of a bot
 *   send.
 *
 * - `workflow_race` (interveners arriving while the bot was just active)
 *   biases conservative — treats as manual_takeover until logs prove
 *   otherwise. False silence is a safer error than false reply.
 *
 * - All non-bot outbound + every inbound (except the current one) is returned
 *   as `history` for fresh and workflow_catchup, so the bot's reply is
 *   coherent with whatever already happened.
 *
 * - `linkAlreadySent` flag is set true when prior context contains a
 *   springbreaku.com reservation URL — prevents the bot from double-sending
 *   the booking link after a workflow drip already shipped it.
 */
type HistoryMsg = { role: 'user' | 'assistant'; content: string };

export type ClassifierResult =
  | { kind: 'fresh'; history: HistoryMsg[]; linkAlreadySent: boolean; openerLikelySent: boolean }
  | { kind: 'clean' }
  | { kind: 'workflow_catchup'; history: HistoryMsg[]; linkAlreadySent: boolean }
  | { kind: 'workflow_race'; reason: string }
  | { kind: 'manual_takeover'; reason: string };

export type ClassifierDiagnostic = {
  contactId: string;
  botGhlMessageIdsCount: number;
  botLastSendAt: number | null;
  hoursSinceBotLastSend: number | null;
  totalRecentMessages: number;
  interveners: Array<{
    id: string;
    direction: 'inbound' | 'outbound';
    source?: string;
    userId?: string;
    dateAdded: string;
    ageMinutes: number;
    bodySnippet: string;
  }>;
  decision: string;
};

// Widened June 16 per code review (P1-4): catch reservation links across
// variant URL shapes — case-insensitive package codes, any springbreaku.com
// subdomain (incl. tracking domains like clicks.springbreaku.com), and the
// shortlink wrapper format GHL uses. False positives are mild (one extra
// suppressed link send); false negatives let the bot double-send the link
// after a workflow already shipped it, which Spiffy will hate.
const RESERVATION_LINK_RE = /(?:springbreaku\.com|gobluetours\.com)\/(?:[a-z0-9-]+\/)*[a-zA-Z0-9]{4,}/i;
const WORKFLOW_DORMANT_HOURS = 6;
const WORKFLOW_RACE_WINDOW_MIN = 30;

export async function classifyConversationContext(
  env: GhlEnv,
  contactId: string,
  botGhlMessageIds: Set<string>,
  currentInboundGhlMessageId: string | null,
  windowSeconds = 600,
): Promise<{ result: ClassifierResult; diagnostic: ClassifierDiagnostic }> {
  const recent = await getRecentMessages(env, contactId, 20);
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;

  // Derive bot's last send time from the messages we recognize.
  let botLastSendAt: number | null = null;
  for (const m of recent) {
    if (m.direction !== 'outbound') continue;
    if (!botGhlMessageIds.has(m.id)) continue;
    const t = new Date(m.dateAdded).getTime();
    if (botLastSendAt === null || t > botLastSendAt) botLastSendAt = t;
  }

  const hoursSinceBotLastSend =
    botLastSendAt === null ? null : (now - botLastSendAt) / (1000 * 60 * 60);

  // Chronological order (oldest first) for history construction.
  const chronological = [...recent].reverse();

  // Build the diagnostic interveners list: non-bot outbound within window,
  // plus inbound messages we want to log for context.
  const interveners: ClassifierDiagnostic['interveners'] = [];
  for (const m of recent) {
    const t = new Date(m.dateAdded).getTime();
    const ageMin = (now - t) / (1000 * 60);
    if (m.direction !== 'outbound') continue;
    if (botGhlMessageIds.has(m.id)) continue;
    if (t < cutoff) continue;
    interveners.push({
      id: m.id,
      direction: m.direction,
      source: m.source,
      userId: m.userId,
      dateAdded: m.dateAdded,
      ageMinutes: Math.round(ageMin * 10) / 10,
      bodySnippet: (m.body || '').slice(0, 80),
    });
  }

  const baseDiag: Omit<ClassifierDiagnostic, 'decision'> = {
    contactId,
    botGhlMessageIdsCount: botGhlMessageIds.size,
    botLastSendAt,
    hoursSinceBotLastSend: hoursSinceBotLastSend === null ? null : Math.round(hoursSinceBotLastSend * 100) / 100,
    totalRecentMessages: recent.length,
    interveners,
  };

  const buildHistory = (excludeCurrentId: string | null): { history: HistoryMsg[]; linkAlreadySent: boolean; openerLikelySent: boolean } => {
    const history: HistoryMsg[] = [];
    let linkAlreadySent = false;
    let openerLikelySent = false;
    const seen = new Set<string>();
    for (const m of chronological) {
      if (!m.body) continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (excludeCurrentId && m.id === excludeCurrentId) continue;
      if (RESERVATION_LINK_RE.test(m.body)) linkAlreadySent = true;
      if (m.direction === 'outbound') openerLikelySent = true;
      history.push({
        role: m.direction === 'outbound' ? 'assistant' : 'user',
        content: m.body,
      });
    }
    return { history, linkAlreadySent, openerLikelySent };
  };

  // CASE 1: fresh contact. No bot tracked sends yet.
  if (botGhlMessageIds.size === 0) {
    const { history, linkAlreadySent, openerLikelySent } = buildHistory(currentInboundGhlMessageId);
    const decision = `fresh (DO empty); ${history.length} prior GHL messages injected as context; openerLikelySent=${openerLikelySent}; linkAlreadySent=${linkAlreadySent}`;
    return {
      result: { kind: 'fresh', history, linkAlreadySent, openerLikelySent },
      diagnostic: { ...baseDiag, decision },
    };
  }

  // CASE 2: clean. No interveners in the window.
  if (interveners.length === 0) {
    return {
      result: { kind: 'clean' },
      diagnostic: { ...baseDiag, decision: 'clean (no interveners in window)' },
    };
  }

  // CASE 2b (P1-3 fix): bot has engaged (botGhlMessageIds.size > 0) but
  // none of those IDs landed in the last 20-message GHL fetch. This means
  // the conversation is long enough that the bot's sends fell off the
  // recent-window scope. We can't apply the time heuristic here without
  // botLastSendAt. Trust DO state — bot has engaged, conversation is
  // healthy, treat the situation as clean rather than silently tagging
  // long conversations as takeovers.
  if (botLastSendAt === null) {
    return {
      result: { kind: 'clean' },
      diagnostic: {
        ...baseDiag,
        decision: `clean (bot has ${botGhlMessageIds.size} tracked sends but none in recent 20-message scope; cannot apply time heuristic; trusting DO state)`,
      },
    };
  }

  // CASE 3 vs 4 vs 5: interveners present, bot has engaged. Classify by time.
  //
  // Real-rep heuristic: reps reply within minutes of seeing a lead message;
  // they don't sit on a stale thread for 6+ hours then suddenly type. So:
  //   - hoursSinceBotLastSend > 6 → almost certainly automated drip (catchup)
  //   - any intervener within 30min of botLastSend → likely race (suspicious)
  //   - between → ambiguous, conservative bias to manual_takeover
  // Note: hoursSinceBotLastSend is guaranteed non-null here by the CASE 2b
  // early-return above. Keeping the !== null guard for TS narrowing only.
  if (hoursSinceBotLastSend !== null && hoursSinceBotLastSend > WORKFLOW_DORMANT_HOURS) {
    const { history, linkAlreadySent } = buildHistory(currentInboundGhlMessageId);
    const decision = `workflow_catchup (botLastSend ${Math.round(hoursSinceBotLastSend * 10) / 10}h ago > ${WORKFLOW_DORMANT_HOURS}h threshold); ${interveners.length} intervener(s) treated as drip; linkAlreadySent=${linkAlreadySent}`;
    return {
      result: { kind: 'workflow_catchup', history, linkAlreadySent },
      diagnostic: { ...baseDiag, decision },
    };
  }

  // Check race window: any intervener within WORKFLOW_RACE_WINDOW_MIN of botLastSend?
  const raceInteveners =
    botLastSendAt === null
      ? []
      : interveners.filter((i) => {
          const ivTs = new Date(i.dateAdded).getTime();
          const diffMin = Math.abs(ivTs - botLastSendAt) / (1000 * 60);
          return diffMin < WORKFLOW_RACE_WINDOW_MIN;
        });
  if (raceInteveners.length > 0) {
    const decision = `workflow_race (intervener within ${WORKFLOW_RACE_WINDOW_MIN}min of bot last send); conservative bias to manual_takeover until logs prove otherwise; intervener_count=${raceInteveners.length}`;
    return {
      result: { kind: 'workflow_race', reason: decision },
      diagnostic: { ...baseDiag, decision },
    };
  }

  // Ambiguous middle case: intervener exists, bot was recent-ish but not racy.
  // Conservative default = manual_takeover.
  const decision = `manual_takeover (interveners present, hoursSinceBotLastSend=${hoursSinceBotLastSend ?? 'null'} in ambiguous middle band)`;
  return {
    result: { kind: 'manual_takeover', reason: decision },
    diagnostic: { ...baseDiag, decision },
  };
}

export async function addContactNote(env: GhlEnv, contactId: string, body: string): Promise<void> {
  const res = await fetch(`${env.baseUrl ?? DEFAULT_BASE}/contacts/${contactId}/notes`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`GHL addContactNote ${res.status}: ${await res.text()}`);
}

/** Normalize a GHL custom-value name/key to a comparable slug (lowercase, underscores). */
function normKey(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Read the location-level custom value the bot quotes for the per-person
 * deposit. In GHL this is the `{{custom_values.deposit_amount}}` merge field,
 * which lives at the LOCATION level (not on the contact), so it's fetched
 * from /locations/{id}/customValues, NOT from the contact record. This is the
 * fix for "bot still says $100 after I set deposit_amount to $75": nothing was
 * ever reading the field, so spiffy.ts fell back to its `?? 100` default.
 *
 * Cached in KV for 5 minutes so we don't add an API round-trip to every inbound.
 * Returns undefined on any failure so the caller keeps its safe default.
 */
export async function getDepositAmount(
  env: GhlEnv,
  kv?: KVNamespace,
): Promise<number | undefined> {
  // Namespace the cache key by location so a multi-location deployment (or
  // shared staging/prod KV) can't serve one location's deposit to another.
  const CACHE_KEY = `cv:${env.locationId}:deposit_amount`;
  if (kv) {
    const cached = await kv.get(CACHE_KEY);
    if (cached !== null && cached !== undefined) {
      const n = Number(cached);
      if (!Number.isNaN(n) && n > 0) return n;
    }
  }
  let res: Response;
  try {
    res = await fetch(`${env.baseUrl ?? DEFAULT_BASE}/locations/${env.locationId}/customValues`, {
      headers: headers(env),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const data = (await res.json()) as any;
  const list: any[] = data.customValues ?? data.custom_values ?? data?.data?.customValues ?? [];
  if (list.length === 0) {
    console.warn('getDepositAmount: customValues response empty or unexpected shape; using default. Keys:', Object.keys(data ?? {}));
    return undefined;
  }
  const match = list.find(
    (cv) =>
      normKey(cv?.name) === 'deposit_amount' ||
      normKey(cv?.fieldKey) === 'deposit_amount' ||
      normKey(cv?.fieldKey).endsWith('deposit_amount') ||
      normKey(cv?.key) === 'deposit_amount',
  );
  if (!match) return undefined;
  const raw = String(match.value ?? '').replace(/[^0-9.]/g, '');
  const num = Number(raw);
  if (Number.isNaN(num) || num <= 0) return undefined;
  if (kv) {
    try {
      await kv.put(CACHE_KEY, String(num), { expirationTtl: 300 });
    } catch {
      /* non-fatal */
    }
  }
  return num;
}
