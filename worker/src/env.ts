export type Env = {
  ANTHROPIC_API_KEY: string;
  GHL_API_KEY: string;
  GHL_LOCATION_ID: string;
  GHL_WEBHOOK_SECRET?: string;
  MIA_MODEL?: string;
  SPIFFY_MODEL?: string;
  /** Persona selector: 'spiffy' (default) or 'meghan'. Set per-worker in wrangler config. */
  PERSONA?: string;
  /**
   * This persona's own outbound SMS line (E.164, e.g. "+19045551234"). When set,
   * every send pins fromNumber to it, so in a multi-number subaccount the bot
   * always replies from ITS line — never GHL's default-number fallback (which
   * only bites the bot-initiated opener, since inbound replies inherit the
   * thread's number). Unset (Spiffy today) = current behavior, GHL chooses.
   */
  SENDER_PHONE?: string;
  CONTACT_THREAD: DurableObjectNamespace;
  IDEMPOTENCY?: KVNamespace;
  DB?: D1Database;
  // ----- Debounce / "wait step" (June 18) -----
  // When "1"/"true", inbound texts are collected in a DO alarm window and
  // answered with ONE reply after the lead stops typing, instead of replying
  // synchronously per text. Any other value (incl. unset) = legacy
  // synchronous behavior (zero behavior change). Default OFF until smoke
  // tested live.
  DEBOUNCE_ENABLED?: string;
  // Public URL of THIS worker, used by the DO alarm to hand the drain off to
  // a fresh worker invocation (a DO cannot fetch itself without deadlocking).
  WORKER_SELF_URL?: string;
  // Shared secret guarding the internal /internal/drain route the alarm calls.
  INTERNAL_DRAIN_SECRET?: string;
};
