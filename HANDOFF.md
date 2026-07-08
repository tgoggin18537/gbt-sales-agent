# GBT Sales Agent — Handoff & Transfer Guide

For the GBT/Go Blue team taking over infrastructure. Everything you need to run, deploy, and own the bot on your own Cloudflare account. Written 2026-07-08.

## What this is

A voice-matched AI SMS sales agent (the "Spiffy bot") for spring break trip sales. It receives inbound lead texts from GoHighLevel via webhook, runs them through a qualification + guardrail pipeline powered by Claude, and replies through GHL. Per-lead conversation state lives in a Cloudflare Durable Object, so every contact has its own persistent thread.

**Stack:** Cloudflare Workers + Durable Objects (SQLite-backed) · Anthropic API (Claude) · GoHighLevel (SMS in/out + CRM) · TypeScript.

## Repo map (what the files are)

```
worker/
  wrangler.toml          Cloudflare config: worker name, DO binding, migrations, vars
  src/index.ts           Entry point, routing
  src/env.ts             Every env var / secret / binding, typed and documented
  src/routes/webhook.ts  Inbound GHL webhook (lead texts arrive here)
  src/routes/simulate.ts /debug/simulate — test conversations without SMS
  src/memory/ContactThread.ts   Durable Object: per-contact conversation state + debounce alarm
  src/agents/classifier.ts      Existing-customer / human-needed classification
  src/agents/guardrail.ts       Output guardrails (banned phrases, style enforcement)
  src/agents/audit-content.ts   Content audit pass
  src/integrations/anthropic.ts Claude API calls
  src/integrations/ghl.ts       GoHighLevel send/read
  src/prompts/spiffy.ts  THE system prompt: voice, qualifier flow, rules (edit here)
  src/prompts/kb.ts      Product knowledge (resorts, pricing structure, party pass)
  src/prompts/faq.ts     FAQ / objection / destination-reaction library
  src/prompts/followups.ts  Drip cadence copy
  src/evals/             Golden test suite + mock conversations + runner
docs/                    Reference docs (product spec, GHL email workflow, tag guide)
SPIFFY_BOT_OVERVIEW.md   What the bot does, in plain English
PHASE_5_MOCK_CONVERSATIONS.md  15 sample conversations showing target behavior
```

## Integration surface (how it connects)

1. **Inbound:** GHL workflow fires a webhook → `POST /webhook` on this worker. Signature-checked with `GHL_WEBHOOK_SECRET`.
2. **Brain:** worker builds the prompt (spiffy.ts + kb.ts + faq.ts + thread history from the DO) → Anthropic API (`SPIFFY_MODEL`, currently `claude-sonnet-4-6`) → guardrail + classifier passes.
3. **Outbound:** reply sent back through the GHL API (`GHL_API_KEY`, `GHL_LOCATION_ID`) as SMS from your number. Human-handoff = silent GHL tag, no message to the lead.
4. **Debounce (optional):** `DEBOUNCE_ENABLED=1` collects rapid-fire texts and answers once when the lead stops typing. Uses a DO alarm that calls back into the worker at `WORKER_SELF_URL` guarded by `INTERNAL_DRAIN_SECRET`. Currently OFF by default.

## Config & secrets (never in the repo)

Set via `wrangler secret put NAME` (or dashboard → Worker → Settings → Variables):

| Name | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic key (console.anthropic.com). You own the billing. |
| `GHL_API_KEY` | GoHighLevel API key for the location |
| `GHL_LOCATION_ID` | The GHL sub-account/location id |
| `GHL_WEBHOOK_SECRET` | Shared secret the GHL webhook signs with |
| `INTERNAL_DRAIN_SECRET` | Any random string; guards the internal debounce route |

Plain vars (in `wrangler.toml` `[vars]`): `SPIFFY_MODEL`, `WORKER_SELF_URL` (set to YOUR worker URL after first deploy), `DEBOUNCE_ENABLED` (optional).

## Transfer to your Cloudflare (step by step)

1. **Prereqs:** Node 18+, `npm i` inside `worker/`, a Cloudflare account (free plan works, DOs here are SQLite-backed which is free-plan compatible), `npx wrangler login` as your account.
2. In `worker/wrangler.toml`: leave `name = "gbt-spiffy"` (or rename), you don't need to change anything else for a first deploy.
3. `npx wrangler deploy` from `worker/`. **Always plain `deploy`, do NOT use `--env production` / `deploy:prod`**, the config keeps vars and the DO binding at top level, and an `--env` deploy silently drops them (known footgun, documented from experience).
4. Note your new worker URL (`https://gbt-spiffy.<your-subdomain>.workers.dev`) and set `WORKER_SELF_URL` in `[vars]` to it, deploy once more.
5. Set the five secrets (`wrangler secret put` each).
6. **Repoint GHL:** in the GHL workflow that fires the webhook, change the URL to your new worker's `/webhook`, and make sure the secret matches. This is the actual cutover moment, until you repoint, the old deployment keeps serving.
7. Smoke test: text the GHL number from a personal phone, watch it reply. Also `POST /debug/simulate` (see `src/routes/simulate.ts`) to test conversations without sending SMS.
8. The Durable Object conversation state does NOT migrate between accounts, existing lead threads start fresh on your deployment. Fine in practice: cut over during a quiet hour; leads mid-conversation get a fresh thread that re-reads GHL context.

## Running the eval suite (do this before any prompt change ships)

```
cd worker
npm run test:unit     # unit tests (guardrail, extraction, debounce)
npm run eval          # golden conversation suite against the prompts
```
The golden suite is the safety net: it replays known-good conversations and fails if the bot's behavior drifts. Prompt edits (spiffy.ts / kb.ts / faq.ts) should always be followed by a green eval run before deploy.

## Care & feeding

- **Prompt changes:** everything about voice and flow lives in `src/prompts/spiffy.ts`. Product facts in `kb.ts`. Change → eval → deploy.
- **Model updates:** bump `SPIFFY_MODEL` var, no code change.
- **Season updates:** pricing/deposits/resorts live in `kb.ts` (deposit tiers, party pass pricing, resort blocks).
- **Logs:** `npx wrangler tail` for live logs; Cloudflare dashboard → Workers → Logs otherwise.

## Support

60-day support window applies from handover for bug fixes and questions on this codebase. Text or email Thomas: 706-540-7294 / thomaswgoggin@gmail.com.
