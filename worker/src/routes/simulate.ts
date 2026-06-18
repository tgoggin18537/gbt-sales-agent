/**
 * /debug/simulate
 *
 * Dry-run endpoint. Takes a conversation history and the latest user
 * message, returns what Mia would reply WITHOUT sending anything through
 * GHL and WITHOUT persisting to the Durable Object.
 *
 * Used for:
 *  - Testing Mia before GHL workflows are wired up.
 *  - Lauren/Nicole adversarial testing via curl or a tiny web UI.
 *  - CI eval runs against the live Worker.
 *
 * Auth: requires the same GHL_WEBHOOK_SECRET header as inbound webhooks.
 */

import { callClaude } from '../integrations/anthropic';
import { SPIFFY_SYSTEM_PROMPT, buildTurnContext } from '../prompts/spiffy';
import { renderFaqForPrompt } from '../prompts/faq';
import { applyGuardrail } from '../agents/guardrail';
import { extractQualifiers } from '../agents/classifier';
import type { Env } from '../env';

const SYSTEM_CACHED = `${SPIFFY_SYSTEM_PROMPT}\n\n${renderFaqForPrompt()}`;

type SimInput = {
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  inbound: string;
  state?: {
    linkSendCount?: number;
    openerSent?: boolean;
    emailCaptured?: string;
    goal?: string;
    painPoint?: string;
    week?: string;
    destination?: string;
    destinationOptions?: string[];
    groupSize?: string;
    school?: string;
  };
};

export async function handleSimulate(req: Request, env: Env): Promise<Response> {
  // No auth on simulate — it's a debug/demo endpoint that doesn't
  // touch GHL or persist state. The inbound webhook route has its own
  // auth check.

  const body = (await req.json()) as SimInput;
  if (!body.inbound) {
    return new Response('bad request: inbound required', { status: 400 });
  }

  const history = (body.history ?? []).map((m) => ({ role: m.role, content: m.content }));
  history.push({ role: 'user' as const, content: body.inbound });

  const state = body.state ?? {};
  // Mirror the webhook's qualifier extraction so simulate faithfully
  // reproduces prod: pull qualifiers from the inbound, merge with any
  // passed-in state (state wins, like the DO's sticky capture).
  const q = extractQualifiers(body.inbound);
  const mergedDestination = state.destination ?? q.destination;
  const captured = {
    week: state.week ?? q.week,
    destination: mergedDestination,
    destinationOptions: mergedDestination
      ? undefined
      : state.destinationOptions ?? q.destinationOptions,
    groupSize: state.groupSize ?? q.groupSize,
    school: state.school ?? q.school,
  };
  const turnCtx = buildTurnContext({
    linkSendCount: state.linkSendCount ?? 0,
    goal: state.goal,
    painPoint: state.painPoint,
    emailCaptured: state.emailCaptured,
    week: captured.week,
    destination: captured.destination,
    destinationOptions: captured.destinationOptions,
    groupSize: captured.groupSize,
    school: captured.school,
  });

  let draft = '';
  let lastViolations: string[] = [];
  let lastReason: string | undefined;
  let linkSentThisTurn = false;
  const attempts: Array<{ raw: string; guard: any }> = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callClaude({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.SPIFFY_MODEL || env.MIA_MODEL || 'claude-sonnet-4-6',
      systemCached: SYSTEM_CACHED,
      systemDynamic: turnCtx,
      messages: history,
      maxTokens: 300,
      temperature: 0.8,
    });
    const guard = applyGuardrail({
      candidate: res.text,
      linkSendCountBefore: state.linkSendCount ?? 0,
      isFirstMessage: !(state.openerSent ?? false),
      priorAssistantMessages: (body.history ?? [])
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content),
      inboundText: body.inbound,
      priorAssistantLengths: (body.history ?? [])
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content.length),
    });
    attempts.push({ raw: res.text, guard });
    if (guard.ok) {
      draft = guard.clean;
      lastViolations = guard.violations;
      linkSentThisTurn = guard.linkSentThisTurn;
      break;
    }
    lastReason = guard.reason;
    history.push({
      role: 'user',
      content: `[system note] Your last draft violated a rule: ${guard.reason}. Rewrite following all rules.`,
    });
  }

  return Response.json({
    ok: !!draft,
    reply: draft || null,
    violations: lastViolations,
    linkSentThisTurn,
    lastGuardrailReason: draft ? null : lastReason,
    attempts,
  });
}
