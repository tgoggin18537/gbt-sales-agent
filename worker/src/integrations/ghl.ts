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
