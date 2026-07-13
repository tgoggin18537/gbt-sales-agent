/**
 * Inbound SMS webhook from GHL.
 *
 * Shape expected (configure in GHL workflow "Webhook" action):
 *   {
 *     "type": "InboundMessage",
 *     "contactId": "...",
 *     "conversationId": "...",
 *     "messageId": "...",
 *     "messageType": "SMS",
 *     "body": "the inbound text",
 *     "phone": "+15555551212",
 *     "tags": ["test-bot", ...],
 *     "customData": { "goal": "...", "painPoint": "..." }
 *   }
 */

import { callClaude } from '../integrations/anthropic';
import {
  addTag,
  addContactNote,
  classifyConversationContext,
  getContact,
  getDepositAmount,
  sendSms,
} from '../integrations/ghl';
import type { ClassifierResult } from '../integrations/ghl';
import { buildTurnContext } from '../prompts/spiffy';
import { systemCachedFor, personaKey, openerFor } from '../prompts/persona';
import { applyGuardrail } from '../agents/guardrail';
import {
  classifyExistingPatient,
  extractEmail,
  extractQualifiers,
  type ExtractedQualifiers,
} from '../agents/classifier';
import { hasExistingCustomerTag } from '../prompts/kb';
import type { MiaState, MiaMessage, PendingMessage } from '../memory/ContactThread';
import type { Env } from '../env';

const SHUTOFF_TAGS = ['do-not-message', 'human-takeover', 'call-booked', 'customer', 'booked', 'traveler'];
const ENGAGED_TAG = 'ai-bot-engaged';
// V5 email cadence (#1.1): when the bot first captures an email, we tag the
// contact with this so a GHL workflow fires the breakdown email send. The
// workflow then adds 'breakdown-sent' (informational) and removes this tag.
// See docs/ghl-email-workflow.md for the GHL setup.
const SEND_BREAKDOWN_TAG = 'send-breakdown-email';

// Spiffy's cold opener. Single-message per Phase 2 decision (multi-bubble
// split deferred to V2 infra upgrade). Pulled verbatim style from his
// transcripts.

// Buying-signal detector for the debounce hot-lead bypass. A lead who clearly
// wants to book ("send me the link", drops an email) shouldn't be made to wait
// out the full debounce window — collapse to HOT_WINDOW. Cheap regex, no LLM.
// Vocabulary mirrors classifyAgreedToBook (classifier.ts) plus pay/deposit cues.
const HOT_LEAD_RE =
  /\b(send (it|me|the link|that|over)|drop the link|gimme the link|book me|sign me up|lets (do it|run it|go|book)|i'?m in|we'?re? (in|ready)|lock (it|me|this) in|ready to (book|go|pay)|deposit|venmo|zelle|how do i pay|put me down|where do i pay)\b/i;
export function isHotLead(body: string): boolean {
  if (!body) return false;
  if (extractEmail(body)) return true; // dropping an email = ready to move
  return HOT_LEAD_RE.test(body);
}

/**
 * Resolve a stable, non-empty messageId from the GHL webhook payload.
 * GHL has shipped multiple payload shapes over time and at least one
 * client workflow sends `messageId: null`. We try the documented field
 * first, then known aliases, then fall back to a synthetic sha256 of
 * (contactId + body) when GHL gives us nothing usable.
 *
 * June 18: dropped the minute-bucket from the seed. The bucket caused a
 * double-fire whenever GHL retried a webhook across a clock-minute
 * boundary (original at :59.8, retry at :00.2 → different bucket →
 * different id → both processed → bot replied twice). Without the
 * bucket, the same (contact, body) always hashes identically, so the
 * KV idempotency layer (600s TTL) + the DO replay ring buffer dedup
 * any retry of the same delivery regardless of when it lands. Cost: a
 * lead legitimately resending the identical text within 600s is treated
 * as a duplicate — which is the correct behavior anyway (we already
 * replied to the first copy).
 */
async function resolveInboundMessageId(
  payload: any,
  contactId: string,
  body: string,
  receivedAt: number,
): Promise<{ id: string; source: string }> {
  const candidates: Array<[string, unknown]> = [
    ['payload.messageId', payload?.messageId],
    ['payload.id', payload?.id],
    ['payload.message?.id', payload?.message?.id],
    ['payload.ghlMessageId', payload?.ghlMessageId],
  ];
  for (const [src, c] of candidates) {
    if (typeof c === 'string' && c.length > 0) return { id: c, source: src };
  }
  // Synthetic fallback: stable for the same (contact, body) pair. Dedup
  // window is bounded by the KV idempotency TTL (600s), not by a
  // wall-clock bucket, so retries that straddle a minute boundary still
  // collapse to one id. (receivedAt intentionally unused in the seed.)
  void receivedAt;
  const seed = `${contactId}:${body}`;
  const buf = new TextEncoder().encode(seed);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const hex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { id: `synthetic-${hex}`, source: 'synthetic' };
}

export async function handleInboundSms(
  req: Request,
  env: Env,
  opts?: { drainContactId?: string },
): Promise<Response> {
  // Two entry modes:
  //   normal  — a real GHL inbound SMS (req has the payload).
  //   drain   — the debounce alarm handed off here (opts.drainContactId set);
  //             there is no single inbound, we answer the queued burst.
  const isDrain = !!opts?.drainContactId;
  const debounceEnabled =
    env.DEBOUNCE_ENABLED === '1' || env.DEBOUNCE_ENABLED === 'true';

  let payload: any = {};
  let contactId: string;
  let inboundBody: string;
  if (isDrain) {
    contactId = opts!.drainContactId!;
    inboundBody = '__DEBOUNCE_DRAIN__';
  } else {
    payload = (await req.json()) as any;
    // Signed webhook check (simple shared secret header).
    const sig = req.headers.get('x-ghl-webhook-secret');
    if (env.GHL_WEBHOOK_SECRET && sig !== env.GHL_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    contactId = payload.contactId;
    inboundBody = (payload.body ?? '').trim();
    if (!contactId || !inboundBody) {
      return new Response('bad request', { status: 400 });
    }
  }

  const receivedAt = Date.now();
  // Inbound message id: resolved from the payload in normal mode; derived from
  // the claimed batch (after /claim-all) in drain mode.
  let inboundMessageId = '';
  if (!isDrain) {
    const resolved = await resolveInboundMessageId(payload, contactId, inboundBody, receivedAt);
    inboundMessageId = resolved.id;
    console.log(`[webhook-msgid] contact=${contactId} resolvedId=${inboundMessageId} source=${resolved.source}`);

    // ----- Idempotency (normal mode only — a drain has no single inbound) -----
    const idemKey = `idem:${contactId}:${inboundMessageId}`;
    if (env.IDEMPOTENCY && (await env.IDEMPOTENCY.get(idemKey))) {
      return Response.json({ skipped: 'duplicate_webhook' });
    }
    if (env.IDEMPOTENCY) {
      await env.IDEMPOTENCY.put(idemKey, '1', { expirationTtl: 600 });
    }
  }

  // ----- Durable Object stub -----
  const doId = env.CONTACT_THREAD.idFromName(contactId);
  const stub = env.CONTACT_THREAD.get(doId);

  // ----- Shutoff tag guard (BOTH modes: a human may take over DURING the
  //       debounce window, so we re-check right before draining a burst) -----
  const contact = await getContact(
    { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
    contactId,
  );
  const tags: string[] = contact.tags ?? [];
  if (SHUTOFF_TAGS.some((t) => tags.includes(t))) {
    if (isDrain) {
      // A human owns the conversation now — silently drop the queued burst.
      try {
        await stub.fetch('https://do/drop-pending', { method: 'POST' });
      } catch (e) {
        console.error('drop-pending on shutoff failed (non-fatal):', e);
      }
      return Response.json({ skipped: 'shutoff_tag_present_drain', tags });
    }
    return Response.json({ skipped: 'shutoff_tag_present', tags });
  }

  // ----- DO init (both modes) -----
  const initRes = await stub.fetch('https://do/init', {
    method: 'POST',
    body: JSON.stringify({
      contactId,
      phone: payload.phone,
      goal: payload.customData?.goal,
      painPoint: payload.customData?.painPoint,
    }),
  });
  let state = (await initRes.json()) as MiaState;

  // NOTE: The conversation-context classifier moved AFTER /claim (see drain
  // loop entry below) per code review P0-3: running it before /claim let
  // concurrent webhooks both classify and both fire side effects (race on
  // openerSent + ENGAGED_TAG). Now only the lock holder classifies;
  // queued webhooks defer entirely.

  // ----- Existing customer checks (normal mode only; the drain answers an
  //       already-vetted burst and must not re-run the LLM existing check) ---
  if (!isDrain) {
    const tagBasedExisting = hasExistingCustomerTag(tags);
    const isExisting =
      tagBasedExisting ||
      (await classifyExistingPatient(env.ANTHROPIC_API_KEY, inboundBody));
    if (isExisting) {
      // Silent handoff: tag and note for human pickup, do NOT send any
      // SMS to the prospect. Per Spiffy V2 (4/29 feedback): when we
      // escalate to a teammate, the conversation should just continue
      // from a human's hands without announcing the swap.
      await addTag(
        { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
        contactId,
        'needs-human',
      );
      await addTag(
        { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
        contactId,
        'human-takeover',
      );
      await addContactNote(
        { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
        contactId,
        `[Spiffy] Existing-customer signal detected. Inbound: "${inboundBody}". Bot is silent; team please respond.`,
      );
      return Response.json({ handled: 'existing_customer_silent' });
    }
  }

  // ----- Initial-touch short-circuit -----
  // Workflow 1 fires the 5-minute-after-add SMS by POSTing body=__INITIAL_TOUCH__.
  // Send the opener verbatim, do not call Claude on a sentinel string.
  if (inboundBody === '__INITIAL_TOUCH__') {
    if (state.openerSent) {
      return Response.json({ skipped: 'opener_already_sent' });
    }
    // P1-1 fix: before sending OUR opener, check if a workflow already
    // sent something opener-shaped (the contact-add "thanks for your
    // interest" + automated-rep-opener pair Spiffy uses). If we detect
    // a likely opener, mark openerSent=true and skip our send so we
    // don't double-opener.
    //
    // Conservative detection: look for our brand keywords ("Spiffy" +
    // "SpringBreak U" / "Go Blue Tours") in any outbound from the
    // last 30 min. If found → workflow already opened. Otherwise →
    // proceed with our opener.
    try {
      const { result: preInitClass, diagnostic } = await classifyConversationContext(
        { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
        contactId,
        new Set(),
        inboundMessageId,
        1800,
      );
      if (preInitClass.kind === 'fresh' && preInitClass.openerLikelySent) {
        const workflowSentOpener = preInitClass.history.some((h) => {
          if (h.role !== 'assistant') return false;
          const text = h.content;
          return (
            /\bSpiffy\b/i.test(text) &&
            (/\bSpringBreak\s*U\b/i.test(text) || /\bGo\s*Blue\s*Tours\b/i.test(text))
          );
        });
        if (workflowSentOpener) {
          console.log(
            `[initial-touch] contact=${contactId} workflow already sent opener-shaped message, marking openerSent=true and skipping our opener. diag=${JSON.stringify(diagnostic)}`,
          );
          await stub.fetch('https://do/append', {
            method: 'POST',
            body: JSON.stringify({ openerSent: true, newState: 'engaged' }),
          });
          await addTag(
            { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
            contactId,
            ENGAGED_TAG,
          );
          return Response.json({ skipped: 'workflow_opener_already_sent' });
        }
      }
    } catch (e) {
      console.error('[initial-touch] pre-send GHL check failed (proceeding with our opener):', e);
    }
    const opener = openerFor(env);
    const sent = await sendSms(
      { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
      { contactId, message: opener },
    );
    await stub.fetch('https://do/append', {
      method: 'POST',
      body: JSON.stringify({
        message: { role: 'assistant', content: opener, at: Date.now(), ghlMessageId: sent.messageId } as MiaMessage,
        openerSent: true,
        newState: 'engaged',
      }),
    });
    await addTag(
      { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
      contactId,
      ENGAGED_TAG,
    );
    return Response.json({ handled: 'initial_touch', sent: opener });
  }

  // ----- Debounce ENQUEUE branch (normal mode, debounce on) -----
  // Instead of replying synchronously, push the inbound onto the DO queue and
  // (re)arm the alarm. The bot answers the whole burst once after the lead
  // stops typing. A buying signal collapses the wait (hot). Returns 200 to GHL
  // immediately; the reply fires later via the alarm → /internal/drain.
  if (!isDrain && debounceEnabled) {
    const hot = isHotLead(inboundBody);
    const enqRes = await stub.fetch('https://do/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        messageId: inboundMessageId,
        body: inboundBody,
        receivedAt: Date.now(),
        hot,
      }),
    });
    const enq = (await enqRes.json()) as
      | { duplicate: true }
      | { enqueued: true; pendingCount: number; hot: boolean; fireInMs: number };
    if ('duplicate' in enq) {
      return Response.json({ skipped: 'duplicate_inbound_via_enqueue' });
    }
    return Response.json({ enqueued: true, pendingCount: enq.pendingCount, hot: enq.hot, fireInMs: enq.fireInMs });
  }

  // ----- Claim the batch -----
  // drain mode: /claim-all pulls the WHOLE queued burst in one shot.
  // normal mode (debounce off): /claim takes the in-flight lock and any
  // orphaned pending, exactly as before. Concurrent webhooks queue + defer.
  let messagesToProcess: PendingMessage[];
  if (isDrain) {
    const claimRes = await stub.fetch('https://do/claim-all', { method: 'POST' });
    const claim = (await claimRes.json()) as
      | { claimed: false; reason: string }
      | { claimed: true; messagesToProcess: PendingMessage[] };
    if (!claim.claimed) {
      return Response.json({ skipped: 'drain_noop', reason: claim.reason });
    }
    messagesToProcess = claim.messagesToProcess;
    // Derive the "current inbound" from the newest message in the burst, for
    // the classifier's current-inbound exclusion and for logging.
    const newest = messagesToProcess[messagesToProcess.length - 1];
    inboundMessageId = newest?.messageId ?? '';
    inboundBody = newest?.body ?? inboundBody;
  } else {
    const claimRes = await stub.fetch('https://do/claim', {
      method: 'POST',
      body: JSON.stringify({
        messageId: inboundMessageId,
        body: inboundBody,
        receivedAt: Date.now(),
      }),
    });
    const claim = (await claimRes.json()) as
      | { duplicate: true }
      | { claimed: false; queued: true; pendingCount: number }
      | { claimed: true; messagesToProcess: PendingMessage[]; staleRecovered?: boolean };
    if ('duplicate' in claim && claim.duplicate) {
      return Response.json({ skipped: 'duplicate_inbound_via_claim' });
    }
    if ('queued' in claim && claim.queued) {
      return Response.json({ queued: true, pendingCount: claim.pendingCount });
    }
    messagesToProcess = (claim as { claimed: true; messagesToProcess: PendingMessage[] }).messagesToProcess;
  }

  // Current per-person deposit, read once from the GHL location custom value
  // {{custom_values.deposit_amount}} (cached 5 min in KV). Fetched here, after
  // the short-circuits, so we don't spend the call on shutoff/opener/existing
  // paths. Falls back to spiffy.ts's safe default if undefined.
  let depositAmount: number | undefined;
  try {
    depositAmount = await getDepositAmount(
      { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
      env.IDEMPOTENCY,
    );
  } catch (e) {
    console.error('deposit custom-value fetch failed (using default):', e);
  }
  const MAX_DEPTH = 3;
  let depth = 0;
  let succeeded = false;
  let lastResponse: Response | null = null;
  const maxAttempts = 3;

  // ----- Conversation context classifier (June 18 — source-driven) -----
  // Four-state discriminated union replacing the binary wasManualOutboundRecent:
  //   - 'fresh'             — bot never engaged. Inject GHL history as context.
  //   - 'clean'             — bot engaged, nothing special.
  //   - 'workflow_catchup'  — workflow drip after bot's last send → inject + continue.
  //   - 'manual_takeover'   — real human rep texted after bot's last send → tag + bail.
  //
  // Uses VERIFIED GHL field semantics (source=workflow ⇒ automation;
  // messageType=TYPE_SMS ⇒ real text; TYPE_ACTIVITY_* ⇒ CRM noise, ignored).
  // See ghl.ts:classifyConversationContext for the full rule set + the
  // June 18 incident that proved the prior time-heuristic design wrong.
  //
  // Runs AFTER /claim (P0-3 fix) so queued concurrent webhooks don't
  // double-classify and double-fire side effects. After each successful
  // send inside the drain loop, we re-derive botGhlMessageIds from the
  // updated currentState so the pre-send recheck doesn't see the bot's
  // own pass-1 send as an "intervener" (P0-1 fix).
  let botGhlMessageIds = new Set<string>(
    state.messages
      .filter((m) => m.role === 'assistant' && !!m.ghlMessageId)
      .map((m) => m.ghlMessageId as string),
  );
  const { result: classification, diagnostic: classifierDiag } = await classifyConversationContext(
    { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
    contactId,
    botGhlMessageIds,
    inboundMessageId,
    600,
  );
  console.log(
    `[classifier] contact=${contactId} kind=${classification.kind} diag=${JSON.stringify(classifierDiag)}`,
  );

  // Real human takeover → tag + release + bail.
  if (classification.kind === 'manual_takeover') {
    await addTag(
      { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
      contactId,
      'human-takeover',
    );
    // We hold the /claim lock — release before bailing so future inbounds
    // can proceed (assuming the rep eventually removes human-takeover).
    try {
      await stub.fetch('https://do/release', {
        method: 'POST',
        body: JSON.stringify({
          processedMessageIds: messagesToProcess.map((m) => m.messageId),
          finalize: true,
        }),
      });
      if (isDrain) await stub.fetch('https://do/finish-drain', { method: 'POST' });
    } catch (e) {
      console.error('failed to release lock on classifier bail (non-fatal):', e);
    }
    return Response.json({
      skipped: 'manual_team_message_detected',
      classifierKind: classification.kind,
      reason: 'reason' in classification ? classification.reason : undefined,
    });
  }

  // P1-1 fix: for 'fresh' classification, only set openerSent if the prior
  // outbound looks like an opener (brand keywords present). A generic
  // workflow text like "we're closed Sunday" should NOT poison openerSent
  // since there's no recovery — once set, the INITIAL_TOUCH path will
  // never fire our real opener.
  if (classification.kind === 'fresh' && classification.openerLikelySent) {
    const workflowSentOpener = classification.history.some((h) => {
      if (h.role !== 'assistant') return false;
      const text = h.content;
      return (
        /\bSpiffy\b/i.test(text) &&
        (/\bSpringBreak\s*U\b/i.test(text) || /\bGo\s*Blue\s*Tours\b/i.test(text))
      );
    });
    if (workflowSentOpener) {
      await stub.fetch('https://do/append', {
        method: 'POST',
        body: JSON.stringify({ openerSent: true, newState: 'engaged' }),
      });
      await addTag(
        { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
        contactId,
        ENGAGED_TAG,
      );
    } else {
      console.log(
        `[classifier] contact=${contactId} fresh+priorOutbound but no opener-shaped message detected; leaving openerSent=false so __INITIAL_TOUCH__ can still fire our opener`,
      );
    }
  }

  // Context injection from classifier. For 'fresh' and 'workflow_catchup',
  // the classifier built a chronological history of prior GHL messages we
  // want Claude to see for THIS turn. We don't persist these to the DO as
  // bot messages — they aren't ours. Subsequent turns will use DO state.
  type HistoryMsg = { role: 'user' | 'assistant'; content: string };
  const classifierContextHistory: HistoryMsg[] =
    classification.kind === 'fresh' || classification.kind === 'workflow_catchup'
      ? classification.history
      : [];
  // If the workflow already sent a booking link, treat one slot as
  // consumed in the turn-context link budget so the bot doesn't
  // double-send. This is a per-turn adjustment; DO linkSendCount unchanged.
  const linkBudgetAdjustment =
    (classification.kind === 'fresh' || classification.kind === 'workflow_catchup') &&
    classification.linkAlreadySent
      ? 1
      : 0;
  if (classifierContextHistory.length > 0) {
    console.log(
      `[classifier-context] contact=${contactId} kind=${classification.kind} injected ${classifierContextHistory.length} prior GHL msgs as Claude history; linkBudgetAdjustment=${linkBudgetAdjustment}`,
    );
  }

  try {
    while (messagesToProcess.length > 0 && depth < MAX_DEPTH) {
      depth++;
      const isFirstPass = depth === 1;

      // Re-load state so each drain pass sees the prior pass's appended turns.
      const stateRes = await stub.fetch('https://do/get');
      const currentState = (await stateRes.json()) as MiaState;

      // P0-1 fix: re-derive botGhlMessageIds at the top of each pass from
      // the now-current DO state. After pass 1's send, the new ghlMessageId
      // landed in state.messages; without this re-derive, pass 2's
      // pre-send recheck would see the bot's own pass-1 send as an
      // "intervener" and tag human-takeover on the bot itself. This
      // recomputes on every pass for safety.
      botGhlMessageIds = new Set<string>(
        currentState.messages
          .filter((m) => m.role === 'assistant' && !!m.ghlMessageId)
          .map((m) => m.ghlMessageId as string),
      );

      // QUALIFIER EXTRACTION (June 18 — bulletproofs multi-fact dumps).
      // Deterministically pull week/destination/group size/school out of
      // this turn's inbound(s), persist newly-captured ones to DO state
      // (sticky), and feed the merged set into the turn context so the bot
      // is told "already captured, don't ask again". This is what stops
      // the bot re-asking for a destination the lead already gave in a
      // multi-fact message.
      const extracted: ExtractedQualifiers = {};
      for (const msg of messagesToProcess) {
        const q = extractQualifiers(msg.body);
        if (q.week && !extracted.week) extracted.week = q.week;
        if (q.destination && !extracted.destination) extracted.destination = q.destination;
        if (q.destinationOptions && !extracted.destinationOptions) extracted.destinationOptions = q.destinationOptions;
        if (q.groupSize && !extracted.groupSize) extracted.groupSize = q.groupSize;
        if (q.school && !extracted.school) extracted.school = q.school;
      }
      const newCaptures =
        (!currentState.week && !!extracted.week) ||
        (!currentState.destination && !!extracted.destination) ||
        (!currentState.destination && !currentState.destinationOptions && !!extracted.destinationOptions) ||
        (!currentState.groupSize && !!extracted.groupSize) ||
        (!currentState.school && !!extracted.school);
      if (newCaptures) {
        await stub.fetch('https://do/append', {
          method: 'POST',
          body: JSON.stringify({
            week: extracted.week,
            destination: extracted.destination,
            destinationOptions: extracted.destinationOptions,
            groupSize: extracted.groupSize,
            school: extracted.school,
          }),
        });
        console.log(
          `[qualifiers] contact=${contactId} captured=${JSON.stringify(extracted)}`,
        );
      }
      // Merged view for THIS turn (already-captured state wins; extraction
      // fills gaps). Used to tell the bot what it already knows. A single
      // captured destination always wins over a pending comparison.
      const mergedDestination = currentState.destination ?? extracted.destination;
      const captured = {
        week: currentState.week ?? extracted.week,
        destination: mergedDestination,
        destinationOptions: mergedDestination
          ? undefined
          : currentState.destinationOptions ?? extracted.destinationOptions,
        groupSize: currentState.groupSize ?? extracted.groupSize,
        school: currentState.school ?? extracted.school,
      };

      const turnCtx = buildTurnContext({
        persona: personaKey(env),
        // If a workflow already sent a booking link, treat one slot as
        // consumed in the turn-context budget so the bot doesn't
        // double-send. DO's linkSendCount is unchanged — this is a
        // per-turn adjustment surfaced via the classifier context.
        linkSendCount: currentState.linkSendCount + linkBudgetAdjustment,
        goal: currentState.goal,
        painPoint: currentState.painPoint,
        emailCaptured: currentState.emailCaptured,
        depositAmount,
        week: captured.week,
        destination: captured.destination,
        destinationOptions: captured.destinationOptions,
        groupSize: captured.groupSize,
        school: captured.school,
      });
      // History seeding:
      //   - DO has tracked turns → use DO as canonical source.
      //   - DO is empty (fresh contact) → seed from classifier's history
      //     (workflow openers, prior inbound).
      //   - DO has turns AND classifier provides workflow_catchup history
      //     (rare, only for first drain pass after dormant interveners)
      //     → prepend the catchup history before DO state so the bot sees
      //     the drip context that was sent while it was silent.
      const baseHistory: Array<{ role: 'user' | 'assistant'; content: string }> =
        currentState.messages.length === 0 && classifierContextHistory.length > 0
          ? [...classifierContextHistory]
          : classification.kind === 'workflow_catchup' && classifierContextHistory.length > 0
            ? [
                ...currentState.messages.map((m) => ({
                  role: m.role as 'user' | 'assistant',
                  content: m.content,
                })),
                ...classifierContextHistory,
              ]
            : currentState.messages.map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
              }));
      const history = baseHistory;
      // Append every messagesToProcess as a separate user turn.
      // Claude responds to the most recent substantive message.
      for (const msg of messagesToProcess) {
        history.push({ role: 'user', content: msg.body });
      }

      // ----- Guardrail retry loop (inline, Spiffy pattern) -----
      let candidate = '';
      let violations: string[] = [];
      let linkSentThisTurn = false;
      let hypeSentThisTurn = false;
      // June 18 (P1-4): captures a hard Claude API failure (billing/credit,
      // rate limit, network) so we route to the silent human-handoff path
      // below instead of letting the throw propagate to a 500 → GHL retry
      // storm. This is the exact failure that made the bot "look dead" when
      // the Anthropic account hit $0.
      let claudeError: string | null = null;
      const attemptLog: Array<{ draft: string; reason?: string }> = [];
      const guardHistory = [...history];
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let claudeRes: { text: string; stopReason: string | null; usage: unknown };
        try {
          claudeRes = await callClaude({
            apiKey: env.ANTHROPIC_API_KEY,
            model: env.SPIFFY_MODEL || env.MIA_MODEL || 'claude-sonnet-4-6',
            systemCached: systemCachedFor(env),
            systemDynamic: turnCtx,
            messages: guardHistory,
            maxTokens: 300,
            temperature: 0.8,
          });
        } catch (e: any) {
          claudeError = e?.message ?? String(e);
          console.error(
            `[claude-error] contact=${contactId} attempt=${attempt + 1}/${maxAttempts}: ${claudeError}`,
          );
          // Don't burn the remaining retries against a failing API
          // (a billing/credit error won't fix itself in 2 more calls).
          break;
        }

        const guard = applyGuardrail({
          candidate: claudeRes.text,
          linkSendCountBefore: currentState.linkSendCount,
          isFirstMessage: !currentState.openerSent,
          priorAssistantMessages: currentState.messages
            .filter((m) => m.role === 'assistant')
            .map((m) => m.content),
          inboundText: messagesToProcess[messagesToProcess.length - 1]?.body ?? inboundBody,
          priorAssistantLengths: currentState.messages
            .filter((m) => m.role === 'assistant')
            .map((m) => m.content.length),
        });

        if (guard.ok) {
          candidate = guard.clean;
          violations = guard.violations;
          linkSentThisTurn = guard.linkSentThisTurn;
          hypeSentThisTurn = guard.hypeSentThisTurn;
          attemptLog.push({ draft: claudeRes.text });
          break;
        } else {
          attemptLog.push({ draft: claudeRes.text, reason: guard.reason });
          const newestBody = messagesToProcess[messagesToProcess.length - 1]?.body ?? inboundBody;
          guardHistory.push({
            role: 'user',
            content: `[system note] Your last draft violated a rule: ${guard.reason}. Rewrite following all rules. Keep it to one short reply, one question maximum. Do not repeat any qualifier already asked twice. Respond to: "${newestBody}"`,
          });
        }
      }

      const processedIds = messagesToProcess.map((m) => m.messageId);
      const inboundForLog = messagesToProcess.map((m) => m.body).join(' || ');

      if (!candidate) {
        // Guardrail never passed after N attempts. V5.5 Section 1.1
        // CRITICAL FIX: the old fallback "hmm good one, lemme think
        // on that real quick" is the EXACT banned phrase Spiffy
        // demanded be removed forever. Per V5.5 1.1 Option B, when
        // the bot genuinely can't answer, do NOT send any message —
        // silently flag for human-takeover and let a rep step in.
        // The contact note still captures the full draft history so
        // we can diagnose, but the lead doesn't see anything.
        await addTag(
          { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
          contactId,
          'needs-human',
        );
        await addTag(
          { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
          contactId,
          'human-takeover',
        );
        const draftDump = attemptLog
          .map((a, i) => `  attempt ${i + 1}${a.reason ? ` (rejected: ${a.reason})` : ''}:\n    ${a.draft}`)
          .join('\n');
        const fallbackReason = claudeError
          ? `Claude API failed (${claudeError}). The bot could not generate a reply — likely an Anthropic billing/credit or rate-limit issue. CHECK THE ANTHROPIC ACCOUNT BALANCE.`
          : `Guardrail exhausted after ${maxAttempts} attempts.`;
        await addContactNote(
          { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
          contactId,
          `[Spiffy] ${fallbackReason} SILENT FALLBACK (no message sent). Inbound: "${inboundForLog}".\nDrafts:\n${draftDump}`,
        );
        for (const msg of messagesToProcess) {
          await stub.fetch('https://do/append', {
            method: 'POST',
            body: JSON.stringify({
              message: { role: 'user', content: msg.body, at: msg.receivedAt, ghlMessageId: msg.messageId } as MiaMessage,
            }),
          });
        }
        // Do NOT append any assistant message — the conversation stays
        // silent and a human picks it up.
        // Finalize: release lock, leave any newly-queued pending for the
        // next inbound (with needs-human tag, unlikely to fire again).
        const releaseRes = await stub.fetch('https://do/release', {
          method: 'POST',
          body: JSON.stringify({ processedMessageIds: processedIds, finalize: true }),
        });
        const release = (await releaseRes.json()) as {
          drained: PendingMessage[];
          lockReleased: boolean;
          deferredCount: number;
        };
        console.log(`[release] contact=${contactId} drained=0 depth=${depth} silentFallback=true deferred=${release.deferredCount}`);
        succeeded = true;
        lastResponse = Response.json({
          handled: 'guardrail_silent_fallback_human_needed',
          sent: null,
          rejectedDrafts: attemptLog
            .filter((a) => a.reason)
            .map((a) => ({ reason: a.reason, draft: a.draft })),
        });
        break;
      }

      // Pre-send recheck (replaces the old 3-sec sleep). Run the classifier
      // ONE MORE TIME right before sending, every pass. If a real rep typed
      // in the window between Claude returning and us sending, the classifier
      // catches it (a non-workflow outbound SMS after the bot's last send) →
      // manual_takeover, we bail. No artificial sleep: the GHL round-trip IS
      // the wait.
      const recheck = await classifyConversationContext(
        { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
        contactId,
        botGhlMessageIds,
        inboundMessageId,
        600,
      );
      if (recheck.result.kind === 'manual_takeover') {
        console.log(
          `[pre-send-recheck] contact=${contactId} kind=${recheck.result.kind} bailing before send. diag=${JSON.stringify(recheck.diagnostic)}`,
        );
        await addTag(
          { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
          contactId,
          'human-takeover',
        );
        await stub.fetch('https://do/release', {
          method: 'POST',
          body: JSON.stringify({ processedMessageIds: processedIds, finalize: true }),
        });
        console.log(`[release] contact=${contactId} drained=0 depth=${depth} preSendRecheckBail=true`);
        succeeded = true;
        lastResponse = Response.json({
          skipped: 'manual_team_message_detected_late',
          classifierKind: recheck.result.kind,
        });
        break;
      }

      const sent = await sendSms(
        { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
        { contactId, message: candidate },
      );

      // AT-MOST-ONCE (drain mode): record the sent ids into the processed ring
      // IMMEDIATELY after the send, before persisting history/tags. DO alarms
      // are at-least-once and the drain runs in a detached waitUntil, so a
      // recovery alarm could re-drive this burst — /claim-all filters out
      // already-ringed ids, making the re-drive a no-op. The dedup window is
      // now just this one DO call wide (send → mark-processed); a crash inside
      // it risks at most ONE duplicate SMS, which is the right tradeoff vs
      // ghosting the lead. Normal synchronous mode has no re-trigger; skip.
      if (isDrain) {
        try {
          await stub.fetch('https://do/mark-processed', {
            method: 'POST',
            body: JSON.stringify({ processedMessageIds: processedIds }),
          });
        } catch (e) {
          console.error('mark-processed failed (non-fatal, /release will ring):', e);
        }
      }

      // Whether THIS send is the school gas-up and the `hype-up` tag should
      // fire. Gated on the persisted hypeSent flag so it fires at most once
      // per contact across drain passes / rapid-fire batches.
      const fireHype = hypeSentThisTurn && !currentState.hypeSent;

      // Email capture: scan only the newest pending message body (the one
      // most likely to contain a freshly-typed email). Cheap regex, no harm
      // in running per pass.
      const newestBody = messagesToProcess[messagesToProcess.length - 1]?.body ?? '';
      const emailSeen = extractEmail(newestBody);
      // V5 #1.1: only fire the breakdown-email workflow on the FIRST capture.
      // Re-firing on later turns (lead repeats their email, etc.) would spam.
      const isFirstEmailCapture = !!emailSeen && !currentState.emailCaptured;

      // Persist every pending user turn, then the assistant reply.
      for (let i = 0; i < messagesToProcess.length; i++) {
        const msg = messagesToProcess[i];
        const isLastUserMsg = i === messagesToProcess.length - 1;
        await stub.fetch('https://do/append', {
          method: 'POST',
          body: JSON.stringify({
            message: { role: 'user', content: msg.body, at: msg.receivedAt, ghlMessageId: msg.messageId } as MiaMessage,
            email: isLastUserMsg ? emailSeen : undefined,
          }),
        });
      }
      await stub.fetch('https://do/append', {
        method: 'POST',
        body: JSON.stringify({
          message: { role: 'assistant', content: candidate, at: Date.now(), ghlMessageId: sent.messageId } as MiaMessage,
          linkSent: linkSentThisTurn,
          openerSent: true,
          hypeSent: fireHype || undefined,
          newState: currentState.state === 'new' ? 'engaged' : undefined,
        }),
      });

      // Tag on first touch (preserved from original; rarely reachable here
      // because the opener short-circuit handles openerSent=false earlier).
      if (!currentState.openerSent) {
        await addTag(
          { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
          contactId,
          ENGAGED_TAG,
        );
      }

      // Fire the `hype-up` tag the moment the bot sends the school gas-up
      // message (detected via the [HYPE] sentinel the prompt appends and the
      // guardrail strips). Gated on currentState.hypeSent so it fires at most
      // once per contact, even across drain passes / rapid-fire batches, so
      // any GHL workflow keyed on the tag doesn't trigger twice. Best-effort;
      // never block the reply on a tag write. (fireHype computed above.)
      if (fireHype) {
        try {
          await addTag(
            { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
            contactId,
            'hype-up',
          );
        } catch (err) {
          console.error('Failed to add hype-up tag:', err);
        }
      }

      // V5 #1.1: fire the breakdown-email workflow trigger on first email
      // capture. Best-effort; if GHL is down we still want to ship the bot
      // reply so we swallow errors and log.
      if (isFirstEmailCapture) {
        try {
          await addTag(
            { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
            contactId,
            SEND_BREAKDOWN_TAG,
          );
        } catch (err) {
          console.error('Failed to add send-breakdown-email tag:', err);
        }
      }

      // Analytics for this pass.
      if (env.DB) {
        try {
          await env.DB.prepare(
            'INSERT INTO turns (contact_id, inbound, outbound, link_sent, violations, at) VALUES (?, ?, ?, ?, ?, ?)',
          )
            .bind(
              contactId,
              inboundForLog,
              candidate,
              linkSentThisTurn ? 1 : 0,
              JSON.stringify(violations),
              new Date().toISOString(),
            )
            .run();
        } catch (e) {
          // non-fatal
          console.error('d1 write failed', e);
        }
      }

      // Release: drain pending if any, finalize on depth cap. Drain mode is
      // always single-pass (claim-all already grabbed the whole burst; any
      // texts that arrived DURING this drain are re-armed by /finish-drain).
      const finalize = isDrain || depth >= MAX_DEPTH;
      const releaseRes = await stub.fetch('https://do/release', {
        method: 'POST',
        body: JSON.stringify({ processedMessageIds: processedIds, finalize }),
      });
      const release = (await releaseRes.json()) as {
        drained: PendingMessage[];
        lockReleased: boolean;
        deferredCount: number;
      };
      console.log(`[release] contact=${contactId} drained=${release.drained.length} depth=${depth}`);
      lastResponse = Response.json({ handled: 'ok', sent: candidate, violations, depth });

      if (release.lockReleased) {
        if (finalize && release.deferredCount > 0) {
          console.log(`[drain-cap] contact=${contactId} hit recursion cap, deferring`);
        }
        succeeded = true;
        break;
      }
      messagesToProcess = release.drained;
    }
    // Loop exited cleanly with no more work and no break: mark success.
    succeeded = true;
  } finally {
    if (!succeeded) {
      try {
        await stub.fetch('https://do/release', {
          method: 'POST',
          body: JSON.stringify({ processedMessageIds: [], finalize: true }),
        });
        console.error(`[release] contact=${contactId} forced after error`);
      } catch (e) {
        console.error('failed to force-release lock', e);
      }
    }
    // Drain cleanup (every drain exit): clear the draining flag and re-arm the
    // alarm if new texts arrived while we were drainng, so they get answered.
    if (isDrain) {
      try {
        await stub.fetch('https://do/finish-drain', { method: 'POST' });
      } catch (e) {
        console.error('finish-drain failed (non-fatal):', e);
      }
    }
  }

  return lastResponse ?? Response.json({ handled: 'no_op' });
}

/**
 * Internal drain entry point, called by the DO alarm (NOT by GHL). Guarded by
 * INTERNAL_DRAIN_SECRET. Acks immediately and runs the drain in ctx.waitUntil
 * so the awaiting DO alarm is freed BEFORE the drain fetches the DO back — a DO
 * cannot service its own fetch while its alarm() is mid-flight (deadlock).
 */
export async function handleInternalDrain(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const secret = env.INTERNAL_DRAIN_SECRET;
  if (!secret || req.headers.get('x-internal-drain-secret') !== secret) {
    return new Response('forbidden', { status: 403 });
  }
  let contactId = '';
  try {
    const body = (await req.json()) as { contactId?: string };
    contactId = body.contactId ?? '';
  } catch {
    return new Response('bad request', { status: 400 });
  }
  if (!contactId) return new Response('contactId required', { status: 400 });
  ctx.waitUntil(
    handleInboundSms(req, env, { drainContactId: contactId }).catch((e) =>
      console.error(`[internal-drain] contact=${contactId} drain failed: ${e}`),
    ),
  );
  return Response.json({ ack: true, contactId });
}
