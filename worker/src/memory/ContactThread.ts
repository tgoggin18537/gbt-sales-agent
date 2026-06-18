/**
 * Durable Object holding per-contact conversation state.
 *
 * One DO instance per GHL contactId. Lives as long as the relationship
 * does. Handles concurrent inbound webhooks serially via a per-contact
 * in-flight lock and a pendingMessages queue (rapid-fire batching).
 */

import type { Env } from '../env';

export type MiaMessage = {
  role: 'user' | 'assistant';
  content: string;
  at: number;
  ghlMessageId?: string;
};

export type PendingMessage = {
  messageId: string;
  body: string;
  receivedAt: number;
};

export type MiaState = {
  contactId: string;
  phone?: string;
  createdAt: number;
  state:
    | 'new'
    | 'engaged'
    | 'booked'
    | 'customer'
    | 'existing_patient'
    | 'human_takeover'
    | 'dnc';
  goal?: string;
  painPoint?: string;
  emailCaptured?: string;
  usConfirmed?: boolean;
  // Captured qualifiers (June 18). Populated by the deterministic
  // extractQualifiers() the moment a lead states one, so the turn context
  // can tell the bot "already captured, do not ask again" — fixes the
  // multi-fact-dump re-ask. Sticky once set (we never overwrite a captured
  // value with undefined).
  week?: string;
  destination?: string;
  /** Destinations the lead is weighing when they've named 2+ (sticky until
   *  a single destination is captured). Tells the bot to push, not re-ask. */
  destinationOptions?: string[];
  groupSize?: string;
  school?: string;
  linkSendCount: number;
  openerSent: boolean;
  /** True once the school gas-up message + `hype-up` tag have fired, so we
   *  never double-fire the tag across drain passes / rapid-fire batches. */
  hypeSent?: boolean;
  messages: MiaMessage[];
  lastInboundGhlMessageId?: string;
  // Rapid-fire batching: in-flight lock + pending queue + replay-protection
  // ring buffer. All optional so existing persisted state without these
  // fields keeps loading cleanly (load() backfills defaults).
  inFlight?: boolean;
  inFlightSince?: number;
  pendingMessages?: PendingMessage[];
  recentInboundIds?: string[];
  // ----- Debounce / "wait step" (June 18) -----
  // When debounce is enabled, inbound texts are pushed to pendingMessages and
  // a single DO alarm is armed (overwritten on each new text = trailing reset)
  // so the bot answers the whole burst once after the lead stops typing.
  /** When the current un-answered burst started (for the MAX_WAIT cap). */
  windowFirstReceivedAt?: number;
  /** True once a buying-signal ("send me the link") collapses the window to
   *  HOT_WINDOW so a hot lead isn't made to wait. Reset after each drain. */
  hotLatched?: boolean;
  /** True while an alarm-triggered drain is running, so a second alarm can't
   *  start a parallel drain of the same queue. Cleared by /finish-drain.
   *  inFlightSince doubles as the drain start time for stale recovery. */
  draining?: boolean;
};

const STALE_LOCK_MS = 60_000;
const RECENT_IDS_CAP = 20;
// Debounce timing. Cold/ambiguous bursts wait DEBOUNCE_WINDOW (trailing,
// re-armed per text); buying signals collapse to HOT_WINDOW; a non-stop
// texter is still answered by MAX_WAIT after their first un-answered text.
const DEBOUNCE_WINDOW_MS = 9_000;
const HOT_WINDOW_MS = 1_500;
const MAX_WAIT_MS = 30_000;
const DEBOUNCE_JITTER_MS = 1_500;
// Recovery: claim-all PEEKS (leaves the burst in the queue) and arms this
// safety alarm. If the detached drain crashes before /finish-drain prunes the
// answered messages, this alarm re-fires after the drain lock goes stale and
// re-drains the still-queued burst — so a crash never ghosts a lead. The
// message-id ring (recorded right after send) makes the re-drain a no-op when
// the send actually succeeded, so recovery only re-sends a genuinely-unsent
// burst. Must be > STALE_LOCK_MS so the re-fire sees the lock as stale.
const DRAIN_RECOVERY_MS = 90_000;

export class ContactThread {
  private state: DurableObjectState;
  private env: Env;
  private data: MiaState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    await this.load();

    if (url.pathname === '/get') {
      return Response.json(this.data);
    }

    if (url.pathname === '/init' && req.method === 'POST') {
      const body = (await req.json()) as Partial<MiaState>;
      if (!this.data) {
        this.data = {
          contactId: body.contactId!,
          phone: body.phone,
          createdAt: Date.now(),
          state: 'new',
          linkSendCount: 0,
          openerSent: false,
          messages: [],
          goal: body.goal,
          painPoint: body.painPoint,
          inFlight: false,
          inFlightSince: 0,
          pendingMessages: [],
          recentInboundIds: [],
        };
        await this.save();
      }
      return Response.json(this.data);
    }

    if (url.pathname === '/append' && req.method === 'POST') {
      // `message` is OPTIONAL (June 16 fix): callers may use /append for
      // state-only updates like setting openerSent=true after detecting
      // a workflow-sent opener, without appending any new message.
      // Without this guard, body.message.role threw "Cannot read
      // properties of undefined" on every state-only append, returning
      // 500 and putting the GHL workflow into a retry loop.
      const body = (await req.json()) as {
        message?: MiaMessage;
        linkSent?: boolean;
        email?: string;
        usConfirmed?: boolean;
        newState?: MiaState['state'];
        openerSent?: boolean;
        hypeSent?: boolean;
        lastInboundGhlMessageId?: string;
        week?: string;
        destination?: string;
        destinationOptions?: string[];
        groupSize?: string;
        school?: string;
      };
      if (!this.data) return new Response('not initialized', { status: 409 });
      // idempotency: if the inbound ghlMessageId matches last seen, drop.
      if (
        body.message &&
        body.message.role === 'user' &&
        body.message.ghlMessageId &&
        body.message.ghlMessageId === this.data.lastInboundGhlMessageId
      ) {
        return Response.json({ duplicate: true, state: this.data });
      }
      if (body.message) this.data.messages.push(body.message);
      if (body.linkSent) this.data.linkSendCount += 1;
      if (body.email) this.data.emailCaptured = body.email;
      if (body.usConfirmed !== undefined) this.data.usConfirmed = body.usConfirmed;
      if (body.newState) this.data.state = body.newState;
      if (body.openerSent) this.data.openerSent = true;
      if (body.hypeSent) this.data.hypeSent = true;
      if (body.lastInboundGhlMessageId)
        this.data.lastInboundGhlMessageId = body.lastInboundGhlMessageId;
      // Captured qualifiers are sticky — only set, never clear. The first
      // time a field is captured it stays, so the bot never re-asks even
      // if a later message doesn't repeat it.
      if (body.week && !this.data.week) this.data.week = body.week;
      if (body.destination && !this.data.destination) this.data.destination = body.destination;
      if (body.groupSize && !this.data.groupSize) this.data.groupSize = body.groupSize;
      if (body.school && !this.data.school) this.data.school = body.school;
      // Options are sticky too, but a single captured destination wins —
      // once they pick one, clear the comparison so the bot stops pushing.
      if (body.destinationOptions && body.destinationOptions.length && !this.data.destination) {
        this.data.destinationOptions = body.destinationOptions;
      }
      if (this.data.destination) this.data.destinationOptions = undefined;
      await this.save();
      return Response.json({ duplicate: false, state: this.data });
    }

    if (url.pathname === '/claim' && req.method === 'POST') {
      const body = (await req.json()) as {
        messageId: string;
        body: string;
        receivedAt: number;
      };
      if (!this.data) return new Response('not initialized', { status: 409 });
      const now = Date.now();
      const contactId = this.data.contactId;
      const pending = this.data.pendingMessages ?? [];
      const recent = this.data.recentInboundIds ?? [];

      // ----- Verbose debug log: emit ONE line per /claim attempt with full
      //       state visibility, so we can see exactly what dedupe (if any)
      //       is matching. Remove once the rapid-fire deploy is stable.
      const inFlightVal = !!this.data.inFlight;
      const inFlightAge = now - (this.data.inFlightSince ?? 0);
      const ringTail = recent.length > 3 ? recent.slice(-3) : recent;
      let matchedOn = 'none';
      // Only compute matchedOn when the incoming id is a non-empty string;
      // otherwise null === null gives a false "match" and lies in the log.
      if (typeof body.messageId === 'string' && body.messageId.length > 0) {
        if (body.messageId === this.data.lastInboundGhlMessageId) {
          matchedOn = 'lastInboundGhlMessageId';
        } else {
          const ringIdx = recent.indexOf(body.messageId);
          if (ringIdx !== -1) {
            matchedOn = `recentInboundIds[${ringIdx}]`;
          } else if (pending.some((p) => p.messageId === body.messageId)) {
            matchedOn = 'pendingMessages';
          }
        }
      } else {
        matchedOn = 'invalid-id-skipped';
      }
      // Hard guard: treat null/undefined/empty messageId as "no id available,
      // do not dedup". Without this guard, multiple inbounds with id=null
      // would all match each other (null === null) and cause permanent
      // silent lockout. With this guard, we accept the message and let it
      // through; the webhook resolver should always supply a real or
      // synthetic id, but if it doesn't we'd rather process duplicates than
      // drop everything.
      const idValid = typeof body.messageId === 'string' && body.messageId.length > 0;
      if (!idValid) {
        console.warn(
          `[claim] contact=${contactId} WARNING incoming messageId is invalid (${typeof body.messageId}, value=${JSON.stringify(body.messageId)}); skipping dedup`,
        );
      }

      console.log(
        `[claim-debug] contact=${contactId} incomingMsgId=${body.messageId} lastInbound=${this.data.lastInboundGhlMessageId ?? 'undefined'} ringSize=${recent.length} ringTail=${JSON.stringify(ringTail)} inFlight=${inFlightVal} inFlightAge=${inFlightAge} matchedOn=${matchedOn} idValid=${idValid}`,
      );

      // Dedupe: previously processed (only if id is valid).
      if (
        idValid &&
        (body.messageId === this.data.lastInboundGhlMessageId ||
          recent.includes(body.messageId))
      ) {
        console.log(
          `[claim] contact=${contactId} claimed=false queued=false pendingCount=${pending.length} duplicate=true`,
        );
        return Response.json({ duplicate: true });
      }
      // Dedupe: same id already queued (only if id is valid).
      if (idValid && pending.some((p) => p.messageId === body.messageId)) {
        console.log(
          `[claim] contact=${contactId} claimed=false queued=false pendingCount=${pending.length} duplicate=true`,
        );
        return Response.json({ duplicate: true });
      }

      const inFlight = !!this.data.inFlight;
      const ageMs = now - (this.data.inFlightSince ?? 0);
      const stale = inFlight && ageMs >= STALE_LOCK_MS;
      let staleRecovered = false;
      if (stale) {
        console.log(
          `[stale-lock] contact=${contactId} ageMs=${ageMs} forcing release`,
        );
        staleRecovered = true;
      }

      if (inFlight && !stale) {
        // Queue the message; lock holder will drain on /release.
        pending.push({
          messageId: body.messageId,
          body: body.body,
          receivedAt: body.receivedAt,
        });
        this.data.pendingMessages = pending;
        await this.save();
        console.log(
          `[claim] contact=${contactId} claimed=false queued=true pendingCount=${pending.length}`,
        );
        return Response.json({
          claimed: false,
          queued: true,
          pendingCount: pending.length,
        });
      }

      // Lock available (or stale-recovered). Merge any orphaned pending with
      // the new message, sorted by receivedAt, so a depth-cap deferral or a
      // crashed worker's leftovers get processed in this pass.
      const merged: PendingMessage[] = [
        ...pending,
        {
          messageId: body.messageId,
          body: body.body,
          receivedAt: body.receivedAt,
        },
      ].sort((a, b) => a.receivedAt - b.receivedAt);
      this.data.pendingMessages = [];
      this.data.inFlight = true;
      this.data.inFlightSince = now;
      await this.save();
      console.log(
        `[claim] contact=${contactId} claimed=true queued=false pendingCount=${merged.length}`,
      );
      return Response.json({
        claimed: true,
        messagesToProcess: merged,
        staleRecovered,
      });
    }

    if (url.pathname === '/release' && req.method === 'POST') {
      const body = (await req.json()) as {
        processedMessageIds: string[];
        finalize?: boolean;
      };
      if (!this.data) return new Response('not initialized', { status: 409 });

      // Update replay-protection ring buffer + last-inbound tracker.
      // Filter out null/undefined/empty ids defensively; never let an
      // invalid id poison the ring buffer or lastInboundGhlMessageId, both
      // of which would cause null=null false matches on subsequent /claim.
      const validProcessedIds = body.processedMessageIds.filter(
        (id) => typeof id === 'string' && id.length > 0,
      );
      if (validProcessedIds.length !== body.processedMessageIds.length) {
        console.warn(
          `[release] contact=${this.data.contactId} dropped ${body.processedMessageIds.length - validProcessedIds.length} invalid processedMessageIds`,
        );
      }
      if (validProcessedIds.length > 0) {
        const recent = this.data.recentInboundIds ?? [];
        for (const id of validProcessedIds) {
          if (!recent.includes(id)) recent.push(id);
        }
        while (recent.length > RECENT_IDS_CAP) recent.shift();
        this.data.recentInboundIds = recent;
        // Per spec: lastInboundGhlMessageId tracks the MOST RECENT processed
        // message in this pass (last in receivedAt order from the caller).
        this.data.lastInboundGhlMessageId =
          validProcessedIds[validProcessedIds.length - 1];
      }

      const pending = this.data.pendingMessages ?? [];
      if (pending.length > 0 && !body.finalize) {
        // Drain: hand pending back to the caller, KEEP lock held so concurrent
        // webhooks continue to queue rather than start a parallel pass.
        const drained = pending
          .slice()
          .sort((a, b) => a.receivedAt - b.receivedAt);
        this.data.pendingMessages = [];
        this.data.inFlightSince = Date.now(); // reset stale clock for next pass
        await this.save();
        return Response.json({ drained, lockReleased: false, deferredCount: 0 });
      }

      // Finalize OR pending empty: release the lock. If finalize and pending
      // is non-empty, we LEAVE pending intact so the next inbound's /claim
      // can merge them via the orphan path.
      const deferredCount = body.finalize ? pending.length : 0;
      this.data.inFlight = false;
      this.data.inFlightSince = 0;
      await this.save();
      return Response.json({ drained: [], lockReleased: true, deferredCount });
    }

    // ============================================================
    // DEBOUNCE ENDPOINTS (June 18 — the "wait step")
    // ============================================================

    // /enqueue: push an inbound onto the pending queue and (re)arm the single
    // DO alarm. The single-alarm overwrite IS the trailing-debounce reset:
    // each new text within the window pushes the fire time later, capped at
    // MAX_WAIT from the first un-answered text. A hot lead collapses to
    // HOT_WINDOW. Replaces /claim on the inbound path when debounce is on.
    if (url.pathname === '/enqueue' && req.method === 'POST') {
      const body = (await req.json()) as {
        messageId: string;
        body: string;
        receivedAt: number;
        hot?: boolean;
      };
      if (!this.data) return new Response('not initialized', { status: 409 });
      const now = Date.now();
      const contactId = this.data.contactId;
      const pending = this.data.pendingMessages ?? [];
      const recent = this.data.recentInboundIds ?? [];
      const idValid = typeof body.messageId === 'string' && body.messageId.length > 0;

      // Dedup: already processed or already queued (only when id is valid;
      // a null/empty id is never deduped — same rule as /claim).
      if (
        idValid &&
        (body.messageId === this.data.lastInboundGhlMessageId ||
          recent.includes(body.messageId) ||
          pending.some((p) => p.messageId === body.messageId))
      ) {
        console.log(`[enqueue] contact=${contactId} duplicate id=${body.messageId}`);
        return Response.json({ duplicate: true });
      }

      const wasEmpty = pending.length === 0;
      pending.push({ messageId: body.messageId, body: body.body, receivedAt: body.receivedAt });
      this.data.pendingMessages = pending;
      if (wasEmpty || !this.data.windowFirstReceivedAt) {
        this.data.windowFirstReceivedAt = now;
      }
      if (body.hot) this.data.hotLatched = true;
      const isHot = body.hot || this.data.hotLatched;

      const cap = (this.data.windowFirstReceivedAt ?? now) + MAX_WAIT_MS;
      // Jitter applied INSIDE the cap so MAX_WAIT stays a hard ceiling.
      const jitter = isHot ? 0 : Math.floor(Math.random() * DEBOUNCE_JITTER_MS);
      const base = isHot ? now + HOT_WINDOW_MS : now + DEBOUNCE_WINDOW_MS + jitter;
      let target = Math.min(base, cap);
      if (target < now + 200) target = now + 200; // never schedule in the past
      await this.state.storage.setAlarm(target);
      await this.save();
      console.log(
        `[enqueue] contact=${contactId} pendingCount=${pending.length} hot=${isHot} fireInMs=${target - now}`,
      );
      return Response.json({
        enqueued: true,
        pendingCount: pending.length,
        hot: isHot,
        fireInMs: target - now,
      });
    }

    // /claim-all: the alarm-triggered drain claims the WHOLE pending burst at
    // once. Returns claimed:false if a drain is already running (prevents
    // parallel drains) or if there's nothing fresh to send. Filters any id
    // already in the processed ring so a stale-recovery re-fire can't reprocess
    // an already-answered message.
    //
    // PEEK semantics (do NOT clear pending): the burst stays in the queue so a
    // crashed detached drain can be re-driven by the recovery alarm. The
    // answered messages are pruned from the queue by /finish-drain only AFTER
    // they're in the processed ring. We arm a recovery alarm here so a drain
    // that dies before /finish-drain still gets retried once the lock is stale.
    if (url.pathname === '/claim-all' && req.method === 'POST') {
      if (!this.data) return new Response('not initialized', { status: 409 });
      const now = Date.now();
      const contactId = this.data.contactId;
      const drainingActive =
        !!this.data.draining && now - (this.data.inFlightSince ?? 0) < STALE_LOCK_MS;
      if (drainingActive) {
        console.log(`[claim-all] contact=${contactId} claimed=false (drain already running)`);
        return Response.json({ claimed: false, reason: 'draining' });
      }
      const pending = this.data.pendingMessages ?? [];
      const ring = this.data.recentInboundIds ?? [];
      const fresh = pending
        .filter((p) => !(typeof p.messageId === 'string' && ring.includes(p.messageId)))
        .sort((a, b) => a.receivedAt - b.receivedAt);
      if (fresh.length === 0) {
        // Everything queued is already answered — prune it, clear the window,
        // cancel any alarm. Nothing to send.
        this.data.pendingMessages = [];
        this.data.windowFirstReceivedAt = undefined;
        this.data.hotLatched = false;
        this.data.draining = false;
        await this.state.storage.deleteAlarm();
        await this.save();
        console.log(`[claim-all] contact=${contactId} claimed=false (empty after filter)`);
        return Response.json({ claimed: false, reason: 'empty' });
      }
      // PEEK: leave pendingMessages in place; finish-drain prunes after send.
      this.data.draining = true;
      this.data.inFlight = true;
      this.data.inFlightSince = now;
      // Recovery alarm: if the detached drain crashes before /finish-drain, this
      // re-fires after the lock goes stale and re-drains the still-queued burst.
      await this.state.storage.setAlarm(now + DRAIN_RECOVERY_MS);
      await this.save();
      console.log(`[claim-all] contact=${contactId} claimed=true count=${fresh.length} (peek)`);
      return Response.json({ claimed: true, messagesToProcess: fresh });
    }

    // /mark-processed: record the just-SENT message ids into the processed ring
    // IMMEDIATELY after sendSms (before persisting history/tags), so the dedup
    // window between a successful send and the rest of the drain is as small as
    // possible. On a recovery re-drain, /claim-all filters these out → no
    // double-text. (Idempotent with the ring update /release also does.)
    if (url.pathname === '/mark-processed' && req.method === 'POST') {
      const body = (await req.json()) as { processedMessageIds: string[] };
      if (!this.data) return new Response('not initialized', { status: 409 });
      const valid = (body.processedMessageIds ?? []).filter(
        (id) => typeof id === 'string' && id.length > 0,
      );
      if (valid.length > 0) {
        const ring = this.data.recentInboundIds ?? [];
        for (const id of valid) if (!ring.includes(id)) ring.push(id);
        while (ring.length > RECENT_IDS_CAP) ring.shift();
        this.data.recentInboundIds = ring;
        this.data.lastInboundGhlMessageId = valid[valid.length - 1];
        await this.save();
      }
      return Response.json({ ok: true, ringed: valid.length });
    }

    // /finish-drain: end of an alarm drain. Prunes the now-answered messages
    // (those in the processed ring) from the queue, clears the draining/in-flight
    // flags, and re-arms the alarm if genuinely-new texts arrived during the
    // drain (there is no synchronous claimer in debounce mode). If nothing is
    // left, cancels the recovery alarm.
    if (url.pathname === '/finish-drain' && req.method === 'POST') {
      if (!this.data) return new Response('not initialized', { status: 409 });
      this.data.draining = false;
      this.data.inFlight = false;
      this.data.inFlightSince = 0;
      const ring = this.data.recentInboundIds ?? [];
      // Drop answered messages; keep only genuinely-unprocessed arrivals.
      const leftover = (this.data.pendingMessages ?? []).filter(
        (p) => !(typeof p.messageId === 'string' && ring.includes(p.messageId)),
      );
      this.data.pendingMessages = leftover;
      let rearmed = false;
      if (leftover.length > 0) {
        const now = Date.now();
        // Preserve the original window start (MAX_WAIT clock) if still set;
        // otherwise anchor it to the earliest leftover message.
        if (!this.data.windowFirstReceivedAt) {
          this.data.windowFirstReceivedAt = Math.min(...leftover.map((p) => p.receivedAt));
        }
        await this.state.storage.setAlarm(now + DEBOUNCE_WINDOW_MS);
        rearmed = true;
      } else {
        this.data.windowFirstReceivedAt = undefined;
        this.data.hotLatched = false;
        await this.state.storage.deleteAlarm(); // cancel the recovery alarm
      }
      await this.save();
      return Response.json({ ok: true, rearmed });
    }

    // /drop-pending: abort a debounce burst WITHOUT replying (e.g. a shutoff
    // tag like human-takeover appeared during the window). Clears the queue,
    // the drain flags, and any pending alarm so nothing fires.
    if (url.pathname === '/drop-pending' && req.method === 'POST') {
      if (!this.data) return new Response('not initialized', { status: 409 });
      this.data.pendingMessages = [];
      this.data.windowFirstReceivedAt = undefined;
      this.data.hotLatched = false;
      this.data.draining = false;
      this.data.inFlight = false;
      this.data.inFlightSince = 0;
      await this.state.storage.deleteAlarm();
      await this.save();
      return Response.json({ ok: true, dropped: true });
    }

    if (url.pathname === '/reset' && req.method === 'POST') {
      // Admin: wipe DO state for this contact. Next /init creates fresh.
      const wipedContactId = this.data?.contactId ?? '<uninitialized>';
      this.data = null;
      await this.state.storage.delete('state');
      await this.state.storage.deleteAlarm(); // cancel any pending debounce drain
      console.log(`[admin-reset] contact=${wipedContactId} state wiped`);
      return Response.json({ ok: true, wiped: true, contactId: wipedContactId });
    }

    return new Response('not found', { status: 404 });
  }

  /**
   * Debounce alarm. Fires once the trailing window elapses. A DO is
   * single-threaded and CANNOT fetch itself without deadlocking, so the alarm
   * does NOT run the reply pipeline directly — it hands off to a fresh worker
   * invocation (/internal/drain) which then fetches this DO via /claim-all.
   * The handoff route acks immediately (work runs in ctx.waitUntil), so this
   * await returns fast and frees the DO before the drain touches it.
   */
  async alarm(): Promise<void> {
    await this.load();
    if (!this.data) return;
    const now = Date.now();
    const contactId = this.data.contactId;
    const pending = this.data.pendingMessages ?? [];
    if (pending.length === 0) {
      this.data.windowFirstReceivedAt = undefined;
      if (this.data.draining) this.data.draining = false;
      await this.save();
      return;
    }
    // A drain is currently running. Don't start a parallel one — but DO re-arm
    // a recovery check just past the stale-lock horizon. If that drain finishes
    // cleanly, /finish-drain prunes the queue and this recovery wake becomes a
    // harmless no-op; if it CRASHED (detached waitUntil torn down before
    // /finish-drain), the queue is still full and the lock is now stale, so the
    // recovery wake re-drives the burst. This is what closes the ghost-on-crash
    // hole: the alarm's own success never implies the detached drain succeeded.
    if (this.data.draining && now - (this.data.inFlightSince ?? 0) < STALE_LOCK_MS) {
      const recoverAt = (this.data.inFlightSince ?? now) + STALE_LOCK_MS + 5_000;
      await this.state.storage.setAlarm(recoverAt);
      console.log(`[alarm] contact=${contactId} drain running — armed recovery check at +${recoverAt - now}ms`);
      return;
    }
    if (this.data.draining) {
      console.log(`[alarm] contact=${contactId} stale drain detected — recovering (re-draining queued burst)`);
    }
    const selfUrl = this.env.WORKER_SELF_URL;
    const secret = this.env.INTERNAL_DRAIN_SECRET;
    if (!selfUrl || !secret) {
      console.error(
        `[alarm] contact=${contactId} missing WORKER_SELF_URL/INTERNAL_DRAIN_SECRET — re-arming to avoid ghosting`,
      );
      await this.state.storage.setAlarm(Date.now() + DEBOUNCE_WINDOW_MS);
      return;
    }
    try {
      const res = await fetch(`${selfUrl.replace(/\/$/, '')}/internal/drain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-drain-secret': secret },
        body: JSON.stringify({ contactId }),
      });
      console.log(`[alarm] contact=${contactId} drain handoff status=${res.status}`);
      if (res.status >= 500) {
        await this.state.storage.setAlarm(Date.now() + 5_000); // transient — retry
      }
    } catch (e) {
      console.error(`[alarm] contact=${contactId} drain handoff failed, retrying: ${e}`);
      await this.state.storage.setAlarm(Date.now() + 5_000);
    }
  }

  private async load() {
    if (this.data) return;
    this.data = (await this.state.storage.get<MiaState>('state')) ?? null;
    // Backfill new fields on state persisted before the in-flight lock landed.
    if (this.data) {
      if (this.data.inFlight === undefined) this.data.inFlight = false;
      if (this.data.inFlightSince === undefined) this.data.inFlightSince = 0;
      if (this.data.pendingMessages === undefined) this.data.pendingMessages = [];
      if (this.data.recentInboundIds === undefined) this.data.recentInboundIds = [];
      if (this.data.draining === undefined) this.data.draining = false;
    }
  }

  private async save() {
    if (this.data) await this.state.storage.put('state', this.data);
  }
}
