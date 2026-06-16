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
  getContact,
  getDepositAmount,
  getRecentMessages,
  sendSms,
  wasManualOutboundRecent,
} from '../integrations/ghl';
import { SPIFFY_SYSTEM_PROMPT, buildTurnContext } from '../prompts/spiffy';
import { renderFaqForPrompt } from '../prompts/faq';
import { applyGuardrail } from '../agents/guardrail';
import {
  classifyExistingPatient,
  extractEmail,
} from '../agents/classifier';
import { hasExistingCustomerTag } from '../prompts/kb';
import type { MiaState, MiaMessage, PendingMessage } from '../memory/ContactThread';
import type { Env } from '../env';

const SHUTOFF_TAGS = ['do-not-message', 'human-takeover', 'call-booked', 'customer', 'booked', 'traveler'];
const ENGAGED_TAG = 'ai-bot-engaged';
// V5 email cadence (#1.1): when the bot first captures an email, we tag the
// contact with this so a GHL workflow fires the breakdown email send. The
// workflow then adds 'breakdown-sent' (informational) and removes this tag.
// See ~/code/gbt-sales-agent/docs/ghl-email-workflow.md for the GHL setup.
const SEND_BREAKDOWN_TAG = 'send-breakdown-email';

// Spiffy's cold opener. Single-message per Phase 2 decision (multi-bubble
// split deferred to V2 infra upgrade). Pulled verbatim style from his
// transcripts.
const OPENER =
  "What's good! It's Spiffy from SpringBreak U here. Which week is your spring break? I'll send over the options and deets";

const SYSTEM_CACHED = `${SPIFFY_SYSTEM_PROMPT}\n\n${renderFaqForPrompt()}`;

/**
 * Resolve a stable, non-empty messageId from the GHL webhook payload.
 * GHL has shipped multiple payload shapes over time and at least one
 * client workflow sends `messageId: null`. We try the documented field
 * first, then known aliases, then fall back to a synthetic sha256 of
 * (contactId + body + minute-bucket) so dedup still works for a 60s
 * window even when GHL gives us nothing usable.
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
  // Synthetic fallback: stable for the same (contact, body, minute) triple.
  const minute = Math.floor(receivedAt / 60_000);
  const seed = `${contactId}:${body}:${minute}`;
  const buf = new TextEncoder().encode(seed);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const hex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { id: `synthetic-${hex}`, source: 'synthetic' };
}

export async function handleInboundSms(req: Request, env: Env): Promise<Response> {
  const payload = (await req.json()) as any;

  // Signed webhook check (simple shared secret header).
  const sig = req.headers.get('x-ghl-webhook-secret');
  if (env.GHL_WEBHOOK_SECRET && sig !== env.GHL_WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  const contactId: string = payload.contactId;
  const inboundBody: string = (payload.body ?? '').trim();

  if (!contactId || !inboundBody) {
    return new Response('bad request', { status: 400 });
  }

  const receivedAt = Date.now();
  const resolved = await resolveInboundMessageId(payload, contactId, inboundBody, receivedAt);
  const inboundMessageId: string = resolved.id;
  console.log(`[webhook-msgid] contact=${contactId} resolvedId=${inboundMessageId} source=${resolved.source}`);

  // ----- Idempotency -----
  const idemKey = `idem:${contactId}:${inboundMessageId}`;
  if (env.IDEMPOTENCY && (await env.IDEMPOTENCY.get(idemKey))) {
    return Response.json({ skipped: 'duplicate_webhook' });
  }
  if (env.IDEMPOTENCY) {
    await env.IDEMPOTENCY.put(idemKey, '1', { expirationTtl: 600 });
  }

  // ----- Shutoff tag guard -----
  const contact = await getContact(
    { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
    contactId,
  );
  const tags: string[] = contact.tags ?? [];
  if (SHUTOFF_TAGS.some((t) => tags.includes(t))) {
    return Response.json({ skipped: 'shutoff_tag_present', tags });
  }

  // ----- Durable Object load/init (moved up so manual-outbound check can
  //       use the set of bot-sent messageIds as ground truth) -----
  const doId = env.CONTACT_THREAD.idFromName(contactId);
  const stub = env.CONTACT_THREAD.get(doId);

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

  // ----- Recent manual SMS guard -----
  // We know which outbound messageIds Spiffy himself sent (persisted in the DO).
  // If any outbound in the window has an id NOT in that set, a human teammate
  // sent it from the inbox and Spiffy should stay quiet.
  const botGhlMessageIds = new Set<string>(
    state.messages
      .filter((m) => m.role === 'assistant' && !!m.ghlMessageId)
      .map((m) => m.ghlMessageId as string),
  );

  // FIRST-TURN EXEMPTION (June 16 bugfix):
  // When the bot has never engaged this contact (zero tracked assistant
  // messages in the DO), the manual-outbound check is meaningless — by
  // definition every prior outbound was "non-bot." That correctly catches
  // a human rep handling the thread before the bot saw it, but it ALSO
  // misfires on Spiffy's standard inbound setup where GHL workflows send
  // the first "thanks for your interest" + opener texts. Those are
  // expected automated preamble, not a human takeover.
  //
  // The fix: only run the manual-outbound check once the bot has at least
  // one tracked turn. After that, the original semantics hold (any
  // outbound NOT in the bot's set was sent by a rep, bot stays quiet).
  // Same protection applies to the late manual check inside the drain
  // loop (depth > 1 means we've already shipped at least one bot reply).
  const isFirstBotTurn = botGhlMessageIds.size === 0;
  if (!isFirstBotTurn) {
    const manualDetected = await wasManualOutboundRecent(
      { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
      contactId,
      botGhlMessageIds,
      600,
    );
    if (manualDetected) {
      await addTag(
        { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
        contactId,
        'human-takeover',
      );
      return Response.json({ skipped: 'manual_team_message_detected' });
    }
  } else {
    console.log(
      `[manual-check-skip] contact=${contactId} first bot turn (no tracked assistant messages); skipping wasManualOutboundRecent so workflow-sent openers don't misfire`,
    );
  }

  // ----- Existing customer checks (tag first, then classifier) -----
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

  // ----- Initial-touch short-circuit -----
  // Workflow 1 fires the 5-minute-after-add SMS by POSTing body=__INITIAL_TOUCH__.
  // Send the opener verbatim, do not call Claude on a sentinel string.
  if (inboundBody === '__INITIAL_TOUCH__') {
    if (state.openerSent) {
      return Response.json({ skipped: 'opener_already_sent' });
    }
    const sent = await sendSms(
      { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
      { contactId, message: OPENER },
    );
    await stub.fetch('https://do/append', {
      method: 'POST',
      body: JSON.stringify({
        message: { role: 'assistant', content: OPENER, at: Date.now(), ghlMessageId: sent.messageId } as MiaMessage,
        openerSent: true,
        newState: 'engaged',
      }),
    });
    await addTag(
      { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
      contactId,
      ENGAGED_TAG,
    );
    return Response.json({ handled: 'initial_touch', sent: OPENER });
  }

  // ----- Claim per-contact in-flight lock (rapid-fire batching) -----
  // From here on we hold the lock until /release. Concurrent webhooks for
  // the same contact will queue into pendingMessages and we'll drain them
  // in the loop below up to MAX_DEPTH passes.
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

  // We hold the lock. Drain loop.
  let messagesToProcess: PendingMessage[] = (claim as {
    claimed: true;
    messagesToProcess: PendingMessage[];
  }).messagesToProcess;
  const MAX_DEPTH = 3;
  let depth = 0;
  let succeeded = false;
  let lastResponse: Response | null = null;
  const maxAttempts = 3;

  // FIRST-TURN GHL HISTORY SYNC (June 16 bugfix):
  // When the bot wakes up fresh on this contact (DO has no tracked
  // assistant messages), pull recent GHL conversation history so the
  // bot's reply is coherent given whatever workflow-sent openers
  // preceded the lead's inbound. Without this, the bot would treat
  // "March 6" as a cold lead inbound with no context of what was
  // already said, and might re-send the opener or sound confused.
  //
  // We DON'T persist these into the DO as bot messages — they aren't
  // ours. They're history-only injection for this turn. Subsequent
  // turns will use the DO's real tracked state.
  type HistoryMsg = { role: 'user' | 'assistant'; content: string };
  let priorWorkflowHistory: HistoryMsg[] = [];
  let workflowOpenerSeen = false;
  if (isFirstBotTurn) {
    try {
      const recent = await getRecentMessages(
        { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
        contactId,
        20,
      );
      // newest-first → reverse to chronological, then drop the current
      // inbound (it's already in messagesToProcess and will be appended
      // separately below).
      const chronological = [...recent].reverse();
      const currentInboundBodyTrim = inboundBody.trim();
      const seenIds = new Set<string>();
      for (const m of chronological) {
        if (!m.body) continue;
        if (seenIds.has(m.id)) continue;
        seenIds.add(m.id);
        // Skip the message we're currently processing (most recent
        // inbound matching the current body within the last few minutes).
        if (
          m.direction === 'inbound' &&
          m.body.trim() === currentInboundBodyTrim
        ) {
          continue;
        }
        priorWorkflowHistory.push({
          role: m.direction === 'outbound' ? 'assistant' : 'user',
          content: m.body,
        });
        if (m.direction === 'outbound') workflowOpenerSeen = true;
      }
      console.log(
        `[first-turn-sync] contact=${contactId} pulled ${priorWorkflowHistory.length} prior messages from GHL (openerSeen=${workflowOpenerSeen}) for context injection`,
      );
      // If workflow-sent outbound exists, mark openerSent so the bot
      // doesn't try to re-send its own opener.
      if (workflowOpenerSeen) {
        await stub.fetch('https://do/append', {
          method: 'POST',
          body: JSON.stringify({ openerSent: true, newState: 'engaged' }),
        });
        await addTag(
          { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
          contactId,
          ENGAGED_TAG,
        );
      }
    } catch (e) {
      console.error('[first-turn-sync] GHL history pull failed:', e);
      // Non-fatal: continue with empty history. Bot will respond cold.
    }
  }

  try {
    while (messagesToProcess.length > 0 && depth < MAX_DEPTH) {
      depth++;
      const isFirstPass = depth === 1;

      // Re-load state so each drain pass sees the prior pass's appended turns.
      const stateRes = await stub.fetch('https://do/get');
      const currentState = (await stateRes.json()) as MiaState;

      const turnCtx = buildTurnContext({
        linkSendCount: currentState.linkSendCount,
        goal: currentState.goal,
        painPoint: currentState.painPoint,
        emailCaptured: currentState.emailCaptured,
        depositAmount,
      });
      // On first bot turn we have no DO state to work with, so seed
      // history from the GHL conversation we synced earlier. On
      // subsequent turns the DO is the source of truth.
      const baseHistory: Array<{ role: 'user' | 'assistant'; content: string }> =
        currentState.messages.length === 0 && priorWorkflowHistory.length > 0
          ? [...priorWorkflowHistory]
          : currentState.messages.map((m) => ({
              role: m.role,
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
      const attemptLog: Array<{ draft: string; reason?: string }> = [];
      const guardHistory = [...history];
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const claudeRes = await callClaude({
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.SPIFFY_MODEL || env.MIA_MODEL || 'claude-sonnet-4-6',
          systemCached: SYSTEM_CACHED,
          systemDynamic: turnCtx,
          messages: guardHistory,
          maxTokens: 300,
          temperature: 0.8,
        });

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
        await addContactNote(
          { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
          contactId,
          `[Spiffy] Guardrail exhausted after ${maxAttempts} attempts. SILENT FALLBACK (no message sent per V5.5 1.1). Inbound: "${inboundForLog}".\nDrafts:\n${draftDump}`,
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

      // Late manual-outbound check (only on first pass; on drain passes the
      // race window vs a teammate sending manually is near-zero seconds).
      // Same first-turn exemption as the upfront check: if the bot has
      // never engaged this contact, the manual check has nothing meaningful
      // to compare against — every prior outbound is automated workflow
      // preamble by definition, not a human rep interrupting the bot.
      if (isFirstPass && !isFirstBotTurn) {
        await new Promise((r) => setTimeout(r, 3000));
        const manualDetectedLate = await wasManualOutboundRecent(
          { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
          contactId,
          botGhlMessageIds,
          600,
        );
        if (manualDetectedLate) {
          await addTag(
            { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
            contactId,
            'human-takeover',
          );
          // Bail without persisting the user/assistant turns. Finalize lock.
          await stub.fetch('https://do/release', {
            method: 'POST',
            body: JSON.stringify({ processedMessageIds: processedIds, finalize: true }),
          });
          console.log(`[release] contact=${contactId} drained=0 depth=${depth} manualLate=true`);
          succeeded = true;
          lastResponse = Response.json({ skipped: 'manual_team_message_detected_late' });
          break;
        }
      }

      const sent = await sendSms(
        { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
        { contactId, message: candidate },
      );

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

      // Release: drain pending if any, finalize on depth cap.
      const finalize = depth >= MAX_DEPTH;
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
  }

  return lastResponse ?? Response.json({ handled: 'no_op' });
}
