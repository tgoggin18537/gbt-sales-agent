/**
 * Cloudflare Worker entry. Routes:
 *  POST /webhook/ghl/inbound-sms   — inbound SMS from GHL
 *  GET  /health                    — liveness
 */

import { handleInboundSms, handleInternalDrain } from './routes/webhook';
import { personaKey } from './prompts/persona';
import { handleSimulate } from './routes/simulate';
import { classifyConversationContext } from './integrations/ghl';
import type { MiaState } from './memory/ContactThread';
import type { Env } from './env';

export { ContactThread } from './memory/ContactThread';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ ok: true, service: `gbt-${personaKey(env)}`, persona: personaKey(env), ts: Date.now(), debounce: env.DEBOUNCE_ENABLED === '1' || env.DEBOUNCE_ENABLED === 'true' });
      }
      // Internal: the DO debounce alarm hands the drain off here (NOT GHL).
      // Guarded by INTERNAL_DRAIN_SECRET. Acks fast; drains in ctx.waitUntil.
      if (req.method === 'POST' && url.pathname === '/internal/drain') {
        return await handleInternalDrain(req, env, ctx);
      }
      if (req.method === 'POST' && url.pathname === '/webhook/ghl/inbound-sms') {
        // June 18 (P1-3): swallow any unexpected throw to a 200. GHL
        // treats non-2xx as retry-worthy and will hammer the endpoint,
        // which is exactly the wrong move when something is already
        // failing (a GHL read 500, a malformed payload, a transient
        // error). Our own DO in-flight lock + KV idempotency are the
        // real recovery path; we never want GHL's blind retry storm on
        // top. handleInboundSms releases its own lock in a finally
        // before any throw reaches here, so swallowing is safe.
        try {
          return await handleInboundSms(req, env);
        } catch (err: any) {
          console.error(
            `[webhook-fatal] contact-unknown swallowing error to 200 (stop GHL retry storm): ${err?.message ?? err}`,
          );
          return Response.json(
            { handled: 'error_swallowed', error: String(err?.message ?? err) },
            { status: 200 },
          );
        }
      }
      if (req.method === 'POST' && url.pathname === '/debug/simulate') {
        return await handleSimulate(req, env);
      }
      // Non-destructive classifier probe: runs classifyConversationContext
      // against a real contact's live GHL + DO state and returns the
      // decision. Sends NO SMS, adds NO tags, mutates nothing. Auth via
      // the same webhook secret. Use to verify takeover-detection on a
      // real contact without firing a message at them.
      if (req.method === 'GET' && url.pathname === '/debug/classify') {
        if (env.GHL_WEBHOOK_SECRET && req.headers.get('x-ghl-webhook-secret') !== env.GHL_WEBHOOK_SECRET) {
          return new Response('forbidden', { status: 403 });
        }
        const contactId = url.searchParams.get('contactId');
        if (!contactId) return new Response('contactId required', { status: 400 });
        const stub = env.CONTACT_THREAD.get(env.CONTACT_THREAD.idFromName(contactId));
        let botIds: string[] = [];
        let doState: Partial<MiaState> = {};
        try {
          const r = await stub.fetch('https://do/get');
          const s = (await r.json()) as MiaState | null;
          if (s && Array.isArray(s.messages)) {
            botIds = s.messages
              .filter((m) => m.role === 'assistant' && !!m.ghlMessageId)
              .map((m) => m.ghlMessageId as string);
            doState = { openerSent: s.openerSent, state: s.state, linkSendCount: s.linkSendCount, messageCount: s.messages.length } as any;
          }
        } catch (e) {
          doState = { error: String(e) } as any;
        }
        const { result, diagnostic } = await classifyConversationContext(
          { locationId: env.GHL_LOCATION_ID, apiKey: env.GHL_API_KEY },
          contactId,
          new Set(botIds),
          url.searchParams.get('inboundId'),
          Number(url.searchParams.get('windowSeconds') ?? 600),
        );
        return Response.json({ contactId, doState, botIdsTracked: botIds.length, classification: result, diagnostic });
      }
      // Debug: read raw DO state for a contact (debounce queue/flags
      // visibility). Secret-guarded, read-only.
      if (req.method === 'GET' && url.pathname === '/debug/do-state') {
        if (env.GHL_WEBHOOK_SECRET && req.headers.get('x-ghl-webhook-secret') !== env.GHL_WEBHOOK_SECRET) {
          return new Response('forbidden', { status: 403 });
        }
        const contactId = url.searchParams.get('contactId');
        if (!contactId) return new Response('contactId required', { status: 400 });
        const stub = env.CONTACT_THREAD.get(env.CONTACT_THREAD.idFromName(contactId));
        const r = await stub.fetch('https://do/get');
        const s = (await r.json()) as MiaState | null;
        return Response.json({
          contactId,
          exists: !!s,
          pendingCount: s?.pendingMessages?.length ?? 0,
          pending: s?.pendingMessages ?? [],
          draining: s?.draining ?? false,
          windowFirstReceivedAt: s?.windowFirstReceivedAt ?? null,
          hotLatched: s?.hotLatched ?? false,
          recentInboundIds: s?.recentInboundIds ?? [],
          messageCount: s?.messages?.length ?? 0,
          openerSent: s?.openerSent ?? false,
        });
      }
      // Debug: seed the debounce queue WITHOUT a real GHL inbound, so the
      // alarm→drain→send path can be exercised end to end on a test contact.
      // Secret-guarded. Mirrors the /enqueue the webhook would do.
      if (req.method === 'POST' && url.pathname === '/debug/enqueue') {
        if (env.GHL_WEBHOOK_SECRET && req.headers.get('x-ghl-webhook-secret') !== env.GHL_WEBHOOK_SECRET) {
          return new Response('forbidden', { status: 403 });
        }
        const b = (await req.json()) as { contactId?: string; body?: string; phone?: string; hot?: boolean };
        if (!b.contactId || !b.body) return new Response('contactId and body required', { status: 400 });
        const stub = env.CONTACT_THREAD.get(env.CONTACT_THREAD.idFromName(b.contactId));
        await stub.fetch('https://do/init', {
          method: 'POST',
          body: JSON.stringify({ contactId: b.contactId, phone: b.phone }),
        });
        const enqRes = await stub.fetch('https://do/enqueue', {
          method: 'POST',
          body: JSON.stringify({
            messageId: `debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            body: b.body,
            receivedAt: Date.now(),
            hot: !!b.hot,
          }),
        });
        return Response.json(await enqRes.json());
      }
      return new Response('not found', { status: 404 });
    } catch (err: any) {
      console.error('worker error', err);
      return new Response(`error: ${err?.message ?? err}`, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
