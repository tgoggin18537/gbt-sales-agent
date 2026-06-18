export type Env = {
  ANTHROPIC_API_KEY: string;
  GHL_API_KEY: string;
  GHL_LOCATION_ID: string;
  GHL_WEBHOOK_SECRET?: string;
  MIA_MODEL?: string;
  SPIFFY_MODEL?: string;
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
