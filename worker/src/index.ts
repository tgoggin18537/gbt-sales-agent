/**
 * Cloudflare Worker entry. Routes:
 *  POST /webhook/ghl/inbound-sms   — inbound SMS from GHL
 *  GET  /health                    — liveness
 */

import { handleInboundSms } from './routes/webhook';
import { handleSimulate } from './routes/simulate';
import { classifyConversationContext } from './integrations/ghl';
import type { MiaState } from './memory/ContactThread';
import type { Env } from './env';

export { ContactThread } from './memory/ContactThread';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ ok: true, service: 'gbt-spiffy', ts: Date.now() });
      }
      if (req.method === 'POST' && url.pathname === '/webhook/ghl/inbound-sms') {
        return await handleInboundSms(req, env);
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
      return new Response('not found', { status: 404 });
    } catch (err: any) {
      console.error('worker error', err);
      return new Response(`error: ${err?.message ?? err}`, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
