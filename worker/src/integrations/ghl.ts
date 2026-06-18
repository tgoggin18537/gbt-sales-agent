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

// Defensive timeout for every GHL HTTP call. Cloudflare Workers don't
// auto-time-out `fetch`, and a hung GHL response (we observed this in
// the June 16 prod incident where the classifier deploy appeared to
// stall on brand-new contacts) blocks the entire webhook request until
// the Worker request deadline. Hard-cap every GHL call at 8 seconds so
// the bot fails fast and gracefully instead.
const GHL_FETCH_TIMEOUT_MS = 8000;

function ghlFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    signal:
      (init as { signal?: AbortSignal } | undefined)?.signal ??
      AbortSignal.timeout(GHL_FETCH_TIMEOUT_MS),
  });
}

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
  const res = await ghlFetch(`${env.baseUrl ?? DEFAULT_BASE}/conversations/messages`, {
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
  const res = await ghlFetch(`${env.baseUrl ?? DEFAULT_BASE}/contacts/${contactId}`, {
    headers: headers(env),
  });
  if (!res.ok) throw new Error(`GHL getContact ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.contact ?? data;
}

export async function addTag(env: GhlEnv, contactId: string, tag: string): Promise<void> {
  const res = await ghlFetch(`${env.baseUrl ?? DEFAULT_BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ tags: [tag] }),
  });
  if (!res.ok) throw new Error(`GHL addTag ${res.status}: ${await res.text()}`);
}

export async function removeTag(env: GhlEnv, contactId: string, tag: string): Promise<void> {
  const res = await ghlFetch(`${env.baseUrl ?? DEFAULT_BASE}/contacts/${contactId}/tags`, {
    method: 'DELETE',
    headers: headers(env),
    body: JSON.stringify({ tags: [tag] }),
  });
  if (!res.ok) throw new Error(`GHL removeTag ${res.status}: ${await res.text()}`);
}

/** Recent messages on the contact's conversation, newest first.
 *  Returns [] on ANY failure (HTTP error, abort/timeout, network blip,
 *  JSON parse error). Caller treats empty-vs-error as identical, so the
 *  bot degrades gracefully when GHL is flaky rather than throwing up.
 */
export type GhlMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  dateAdded: string;
  userId?: string;
  source?: string;
  /** GHL message type. Verified June 18 from real prod data:
   *  TYPE_SMS (actual text), TYPE_EMAIL (workflow breakdown email),
   *  TYPE_ACTIVITY_OPPORTUNITY (CRM activity row, NOT a text — these
   *  were being misread as outbound texts and tripping the classifier). */
  messageType?: string;
};

export async function getRecentMessages(
  env: GhlEnv,
  contactId: string,
  limit = 20,
): Promise<GhlMessage[]> {
  try {
    // Resolve conversation id
    const convRes = await ghlFetch(
      `${env.baseUrl ?? DEFAULT_BASE}/conversations/search?locationId=${env.locationId}&contactId=${contactId}`,
      { headers: headers(env) },
    );
    if (!convRes.ok) return [];
    const conv = (await convRes.json()) as any;
    const conversationId = conv.conversations?.[0]?.id;
    if (!conversationId) return [];

    const msgRes = await ghlFetch(
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
      messageType: m.messageType,
    }));
  } catch (e: any) {
    // AbortError (timeout), network error, JSON parse error, etc.
    console.error(
      `[getRecentMessages] contact=${contactId} failed (${e?.name ?? 'unknown'}): ${e?.message ?? e}`,
    );
    return [];
  }
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
 * Conversation context classifier (rewritten June 18 with VERIFIED GHL
 * field semantics from real prod data).
 *
 * Replaces the binary `wasManualOutboundRecent` + the fragile time-based
 * heuristic with a source-driven discriminator. Four states:
 *   - fresh            : bot never engaged this contact.
 *   - clean            : bot engaged, nothing needs special handling.
 *   - workflow_catchup : a GHL workflow drip fired after the bot's last
 *                        send (e.g. daily follow-up) — inject as context,
 *                        let the bot continue.
 *   - manual_takeover  : a real human rep sent a text after the bot's last
 *                        send — tag human-takeover, stay silent.
 *
 * The June 18 incident proved the prior design wrong on real data. Two
 * classes of message were being misread as "rep interventions":
 *
 *   1. CRM ACTIVITY ROWS. GHL returns "Opportunity created / updated" rows
 *      with direction=outbound and messageType=TYPE_ACTIVITY_OPPORTUNITY.
 *      These are NOT texts. One landed 6 seconds before the bot's reply and
 *      tripped the 30-min "race" window → the bot tagged itself
 *      human-takeover after a perfectly good first reply.
 *
 *   2. PRE-BOT WORKFLOW OPENERS. The workflow-sent opener texts
 *      ("What's good! It's Spiffy...") predate the bot's first reply but
 *      sat in the recent-message window and counted as interveners on the
 *      next turn.
 *
 * Verified field semantics (real Spiffy GHL data, June 18):
 *   - messageType: TYPE_SMS (real text) | TYPE_EMAIL (workflow breakdown)
 *     | TYPE_ACTIVITY_* (CRM noise, not a message).
 *   - source: 'workflow' (automation — drip/opener) | 'app' (bot send OR
 *     human inbox send) | undefined (inbound).
 *
 * Rules (all three filters required to be a real "intervener"):
 *   - outbound TYPE_SMS only (excludes activities + emails)
 *   - source !== 'workflow' (workflow automation is never a takeover)
 *   - dateAdded strictly AFTER the bot's last send (a rep takeover happens
 *     after the bot speaks; pre-bot workflow preamble doesn't count)
 *   - not in botGhlMessageIds (not the bot's own send)
 *
 * source is now a TRUSTED signal for workflow-vs-human. The old comment on
 * wasManualOutboundRecent said source couldn't distinguish bot-vs-manual —
 * still true (both are 'app') — but it cleanly distinguishes workflow
 * automation from everything else, which is the distinction that matters
 * here.
 */
type HistoryMsg = { role: 'user' | 'assistant'; content: string };

export type ClassifierResult =
  | { kind: 'fresh'; history: HistoryMsg[]; linkAlreadySent: boolean; openerLikelySent: boolean }
  | { kind: 'clean' }
  | { kind: 'workflow_catchup'; history: HistoryMsg[]; linkAlreadySent: boolean }
  | { kind: 'manual_takeover'; reason: string };

export type ClassifierDiagnostic = {
  contactId: string;
  botGhlMessageIdsCount: number;
  botLastSendAt: number | null;
  totalRecentMessages: number;
  realSmsCount: number;
  interveners: Array<{
    id: string;
    source?: string;
    messageType?: string;
    userId?: string;
    dateAdded: string;
    ageMinutes: number;
    bodySnippet: string;
  }>;
  decision: string;
};

// Widened June 16 (P1-4): catch reservation links across variant URL
// shapes — any springbreaku.com / gobluetours.com path with a code.
const RESERVATION_LINK_RE = /(?:springbreaku\.com|gobluetours\.com)\/(?:[a-z0-9-]+\/)*[a-zA-Z0-9]{4,}/i;

/** An outbound row that is an actual SMS text (not a CRM activity / email). */
function isOutboundText(m: GhlMessage): boolean {
  return m.direction === 'outbound' && m.messageType === 'TYPE_SMS';
}
/** Any row that belongs in conversational history (inbound texts + outbound
 *  SMS texts). Excludes CRM activity rows and workflow breakdown emails. */
function isConversational(m: GhlMessage): boolean {
  if (m.direction === 'inbound') {
    // Inbound is always a real lead message; only exclude explicit activities.
    return !String(m.messageType ?? '').startsWith('TYPE_ACTIVITY');
  }
  return isOutboundText(m);
}

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

  // Bot's last send = newest outbound TYPE_SMS whose id we recognize.
  let botLastSendAt: number | null = null;
  for (const m of recent) {
    if (!isOutboundText(m)) continue;
    if (!botGhlMessageIds.has(m.id)) continue;
    const t = new Date(m.dateAdded).getTime();
    if (botLastSendAt === null || t > botLastSendAt) botLastSendAt = t;
  }

  // Chronological (oldest first) for history construction.
  const chronological = [...recent].reverse();
  const realSmsCount = recent.filter((m) => isOutboundText(m) || m.direction === 'inbound').length;

  // Real human interveners: outbound TYPE_SMS, not workflow automation, not
  // the bot, within window, AND strictly after the bot's last send (so the
  // workflow opener preamble that predates the bot never counts). If
  // botLastSendAt is null (bot engaged but sends fell off the 20-msg window),
  // we can't time-gate — fall back to "any non-workflow non-bot SMS in window."
  const humanInterveners = recent.filter((m) => {
    if (!isOutboundText(m)) return false;
    if (m.source === 'workflow') return false;
    if (botGhlMessageIds.has(m.id)) return false;
    const t = new Date(m.dateAdded).getTime();
    if (t < cutoff) return false;
    if (botLastSendAt !== null && t <= botLastSendAt) return false;
    return true;
  });

  // Workflow drips after the bot's last send (daily follow-up automations).
  const workflowDripsAfterBot = recent.filter((m) => {
    if (!isOutboundText(m)) return false;
    if (m.source !== 'workflow') return false;
    const t = new Date(m.dateAdded).getTime();
    if (t < cutoff) return false;
    if (botLastSendAt !== null && t <= botLastSendAt) return false;
    return true;
  });

  const baseDiag: Omit<ClassifierDiagnostic, 'decision'> = {
    contactId,
    botGhlMessageIdsCount: botGhlMessageIds.size,
    botLastSendAt,
    totalRecentMessages: recent.length,
    realSmsCount,
    interveners: humanInterveners.map((m) => ({
      id: m.id,
      source: m.source,
      messageType: m.messageType,
      userId: m.userId,
      dateAdded: m.dateAdded,
      ageMinutes: Math.round(((now - new Date(m.dateAdded).getTime()) / 60000) * 10) / 10,
      bodySnippet: (m.body || '').slice(0, 80),
    })),
  };

  const buildHistory = (excludeCurrentId: string | null) => {
    const history: HistoryMsg[] = [];
    let linkAlreadySent = false;
    let openerLikelySent = false;
    const seen = new Set<string>();
    for (const m of chronological) {
      if (!isConversational(m)) continue; // drops activities + emails
      if (!m.body) continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (excludeCurrentId && m.id === excludeCurrentId) continue;
      if (RESERVATION_LINK_RE.test(m.body)) linkAlreadySent = true;
      if (m.direction === 'outbound') openerLikelySent = true;
      history.push({ role: m.direction === 'outbound' ? 'assistant' : 'user', content: m.body });
    }
    return { history, linkAlreadySent, openerLikelySent };
  };

  // CASE 1: fresh contact. Bot never engaged. Inject prior SMS as context.
  if (botGhlMessageIds.size === 0) {
    const { history, linkAlreadySent, openerLikelySent } = buildHistory(currentInboundGhlMessageId);
    return {
      result: { kind: 'fresh', history, linkAlreadySent, openerLikelySent },
      diagnostic: {
        ...baseDiag,
        decision: `fresh (DO empty); ${history.length} prior SMS as context; openerLikelySent=${openerLikelySent}; linkAlreadySent=${linkAlreadySent}`,
      },
    };
  }

  // CASE 2: real human rep typed a text after the bot's last send. Bail.
  if (humanInterveners.length > 0) {
    return {
      result: {
        kind: 'manual_takeover',
        reason: `manual_takeover (${humanInterveners.length} human SMS after bot last send; e.g. "${(humanInterveners[0].body || '').slice(0, 40)}")`,
      },
      diagnostic: { ...baseDiag, decision: `manual_takeover (${humanInterveners.length} human intervener(s))` },
    };
  }

  // CASE 3: a workflow drip fired after the bot's last send (daily follow-up).
  // Inject the conversation (incl. the drip) as context and let the bot
  // continue in-flow. No time gate needed — source=workflow is definitive.
  if (workflowDripsAfterBot.length > 0) {
    const { history, linkAlreadySent } = buildHistory(currentInboundGhlMessageId);
    return {
      result: { kind: 'workflow_catchup', history, linkAlreadySent },
      diagnostic: {
        ...baseDiag,
        decision: `workflow_catchup (${workflowDripsAfterBot.length} workflow drip(s) after bot last send; injecting ${history.length} msgs)`,
      },
    };
  }

  // CASE 4: nothing special. Bot's DO state is the source of truth.
  return {
    result: { kind: 'clean' },
    diagnostic: { ...baseDiag, decision: 'clean (no human interveners or workflow drips after bot last send)' },
  };
}

export async function addContactNote(env: GhlEnv, contactId: string, body: string): Promise<void> {
  const res = await ghlFetch(`${env.baseUrl ?? DEFAULT_BASE}/contacts/${contactId}/notes`, {
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
    res = await ghlFetch(`${env.baseUrl ?? DEFAULT_BASE}/locations/${env.locationId}/customValues`, {
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
