/**
 * Spiffy bot post-processing guardrail.
 *
 * Applied to every outbound message before it ships. Enforces
 * deterministic voice + formatting rules so the LLM cannot regress.
 *
 * Rules relaxed for Spiffy (evidence-backed in phase 2):
 *  - Lowercase message starts allowed (~40% of Spiffy's real msgs).
 *  - Compound-question check is >=2 "?" marks only. The playbook's
 *    two-clause-stem check is disabled — too many false positives
 *    against Spiffy's "yall down for X or prefer Y?" style.
 *  - "I understand" / "I hear you" / "happy to help" / "totally" are
 *    allowed but SOFT-CAPPED at 1 per conversation via
 *    priorAssistantMessages.
 *  - Wellness-claim ban removed (not a wellness brand).
 *
 * Rules kept / added for Spiffy:
 *  - No em/en/figure dashes; hyphens between letters softened.
 *  - No emoji at all (opener included).
 *  - No summary labels.
 *  - No self-initiator framing ("reached out", "reaching out").
 *  - No staff names: Vivian, Ashton, Alex, Aleesa, Tony, Justin
 *    Rodriguez, Manuel.
 *  - No hallucinated reservation links: the bot does NOT generate
 *    /package/[CODE] URLs. If any secure.springbreaku.com URL appears,
 *    reject so Spiffy's back-office can inject the real link.
 *  - Banned openers: Great question, Absolutely, Thanks for reaching
 *    out, Certainly, That's a great point, Short version, TL;DR, etc.
 *  - Link budget: 2 per conversation.
 *  - Length cap ~450 chars (3 SMS segments). Spiffy's median is much
 *    shorter; cap is a safety net.
 */

const BANNED_OPENERS = [
  /^\s*great question[!,.\s]/i,
  /^\s*absolutely[!,.\s]/i,
  /^\s*that'?s a great point/i,
  /^\s*certainly[!,.\s]/i,
  /^\s*thanks for reaching out/i,
  // Summary labels as openers — also stripped mid-message below, but
  // opener-position is an outright reject since it's an AI tell.
  /^\s*short version\s*[:,]/i,
  /^\s*quick version\s*[:,]/i,
  /^\s*tl;?dr\b/i,
  /^\s*in short,/i,
  /^\s*to sum up,/i,
  /^\s*long story short,/i,
  /^\s*the short answer/i,
];

// Phrases that sound templated or off-voice regardless of position.
// Self-initiator framing: every lead filled a form, Spiffy is never the
// initiator. Spiffy says "checkin in" for follow-ups, never "I wanted to
// reach out".
const BANNED_PHRASES: RegExp[] = [
  /\bwhat'?s on your radar\b/i,
  /\bwhat brings you here\b/i,
  // "I/we [('ll|will|'m|am|'re|are|'ve|have|'d|would)] reach(ed|ing) out"
  /\b(I|we)(?:'ll|\s+will|'m|\s+am|'re|\s+are|'ve|\s+have|'d|\s+would)?\s+reach(?:ed|ing)?\s+out\b/i,
  // "I/we (just) want(ed) to reach out"
  /\b(I|we)(?:\s+just)?\s+want(?:ed)?\s+to\s+reach\s+out\b/i,
  // "just want(ed) to reach out / check in / follow up" (no I/we anchor)
  /\bjust\s+want(?:ed)?\s+to\s+(?:reach\s+out|check\s+in|follow\s+up)\b/i,
  /\bfigured\s+I'?d\s+reach\s+out\b/i,
  /\bthanks?\s+for\s+reaching\s+out\b/i,
  // ---- APOLOGY+REPLAY BAN (LLMD V3 port) ----
  // Tech-failure apologies Claude sometimes invents when it sees two
  // consecutive user messages with no bot reply in between.
  /\bsorry,?\s+(?:about that|something|my last|that got)/i,
  /\b(my last message|what i said|let me try (that|again)|to recap what i said)\b/i,
  /\b(scrambled|glitched|got messed up|got cut off on my end|something went wrong on my end)\b/i,
];

// Real rep names that surface in the transcripts. Bot must never
// impersonate or route to them by name. See SPIFFY_V2_QUESTIONS.md to
// expand.
const STAFF_NAMES = [
  'Vivian',
  'Ashton',
  'Alex',
  'Aleesa',
  'Tony',
  'Justin Rodriguez',
  'Manuel',
];

const CANONICAL_NAME = 'Spiffy';

// Name-format rule: Spiffy always signs as "Spiffy" in transcripts.
// If the bot ever tries "Derrick" or his full name, normalize to
// "Spiffy". Very cheap rewrite, never a reject.
const NAME_VARIANTS = [
  /\bDerrick Spiffy Darko\b/g,
  /\bDerrick Darko\b/g,
  /\bDerrick\b/g,
];

// The bot does NOT generate reservation-link codes. Any URL matching
// the package format means the LLM hallucinated one. Reject so the
// server / Spiffy injects a real link.
const HALLUCINATED_LINK_PATTERN =
  /secure\.springbreaku\.com\/site\/public\/package\/[A-Z0-9]+/i;

// "AI-tell" phrases to soft-cap at 1 per conversation. Spiffy DOES use
// these sparingly (evidence in Phase 2 voice synthesis) but over-use
// is the #1 bot tell. Same mechanism as goal-menu repeat: if any prior
// assistant message already contained the phrase, reject on the next.
const AI_TELL_PATTERNS: { name: string; rx: RegExp }[] = [
  { name: 'i_understand', rx: /\bI understand\b/i },
  { name: 'i_hear_you', rx: /\bI hear you\b/i },
  { name: 'happy_to_help', rx: /\bhappy to help\b/i },
  { name: 'totally', rx: /\btotally\b/i },
  { name: 'i_feel_you', rx: /\bI feel you\b/i },
];

// Question-stem detector. Used to distinguish rhetorical questions
// (whose "?" is followed by a declarative) from real answer-seeking
// questions.
const QUESTION_STEM =
  /^(?:what(?:'s|s)?|how(?:'s|s)?|when|where|why|who|which|is|are|was|were|do|does|did|can|could|would|will|should|have|has|had|any|want|u\s)\b/i;

// Qualifier question families. Bot should not ask the same qualifier
// more than twice in a thread; 3rd ask is form-field behavior.
const QUALIFIER_FAMILIES: { name: string; rx: RegExp }[] = [
  {
    name: 'week',
    rx: /\bwhich\s+week\b|\bwhat\s+week\b|\byou\s+know\s+which\s+week\b|\bwhen'?s?\s+your\s+spring\s+break\b|\bwhat'?s?\s+your\s+spring\s+break\s+week\b/i,
  },
  {
    name: 'destination',
    rx: /\bwhich\s+destination\b|\bwhat\s+destination\b|\bwhere\s+(?:were|are)\s+(?:you|y'?all)\s+lookin(?:g)?\s+to\s+(?:book|go)\b|\bwhere\s+(?:you|y'?all)\s+(?:wanna|want to)\s+go\b/i,
  },
  {
    name: 'group_size',
    rx: /\bhow\s+many\s+ppl\b|\bhow\s+many\s+people\b|\bhow\s+big\s+is\s+(?:the|your)\s+group\b|\bgroup\s+size\b|\bhow\s+many\s+in\s+(?:the|your)\s+group\b/i,
  },
  {
    name: 'school',
    rx: /\bwhich\s+school\b|\bwhat\s+school\b|\bwhere\s+(?:y'?all|you\s+all|you|ya)\s+(?:from|at|go)\b/i,
  },
  {
    name: 'timeline',
    rx: /\bhow\s+soon\b|\blookin(?:g)?\s+to\s+(?:book|lock|get\s+(?:things|it)\s+(?:locked|booked))\b|\bwhen\s+(?:were|are)\s+you\s+lookin(?:g)?\b|\btime(?:line|frame)\b/i,
  },
];

/**
 * Count real answer-seeking questions in a message.
 *
 * A "?" followed by a declarative clause (a statement, not another
 * question-stem) is treated as rhetorical and does NOT count. Only
 * "?"s followed by nothing or by another question-stem clause count.
 *
 * Examples:
 *  - "honest take? Punta Cana all day. which week yall goin?" -> 1
 *    ("honest take?" is rhetorical, answered by "Punta Cana all day.")
 *  - "is it cool if I send through email? its a little long for text" -> 0
 *    (permission question answered by the declarative reason)
 *  - "what week are you goin? how many ppl?" -> 2 (compound)
 *  - "yall goin Riu or Tesoro?" -> 1 (single question with "or" alt)
 */
function countRealQuestions(text: string): number {
  const qIndices: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '?') qIndices.push(i);
  if (qIndices.length === 0) return 0;

  let realCount = 0;
  for (let i = 0; i < qIndices.length; i++) {
    const q = qIndices[i];
    // Look at text AFTER this "?" up to the next sentence break (".", "!", "?", end).
    const rest = text.slice(q + 1);
    const nextBreak = rest.search(/[.!?\n]/);
    const afterChunkRaw = nextBreak === -1 ? rest : rest.slice(0, nextBreak);
    const afterChunk = afterChunkRaw.trim().replace(/^[,\s]+/, '');

    if (afterChunk.length === 0) {
      // Trailing "?" at end of message. Count as real.
      realCount += 1;
      continue;
    }

    // Does the following clause look like another question?
    if (QUESTION_STEM.test(afterChunk)) {
      // Another Q follows -> current "?" is a real Q, and the next one
      // will also get counted on its own iteration.
      realCount += 1;
      continue;
    }

    // Following clause is declarative -> the preceding "?" was rhetorical.
    // Don't count.
  }

  return realCount;
}

// Matches em dash, en dash, figure dash, horizontal bar, minus.
const DASH_CHARS = /[\u2012\u2013\u2014\u2015\u2212]/g;

const EMOJI_REGEX =
  /[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{2600}-\u{27BF}\u{1F680}-\u{1F6FF}]/gu;

// Patterns that signal the inbound was an objection, stall, thanks, or
// emotional moment — turns where Spiffy would just respond and STOP,
// never tack on a qualifier question.
const SOFT_TURN_INBOUND: RegExp[] = [
  /\b(?:thanks|thank you|thx|ty|appreciate it)\b/i,
  /\b(?:cool thanks|ok thanks|ok cool|sounds good|ok bet|aight|np|no prob)\b/i,
  /\b(?:just looking|not ready|not today|maybe later|not sure yet)\b/i,
  /\b(?:let me (?:ask|talk|check|think)|need to (?:ask|talk|check|think))\b/i,
  /\b(?:too expensive|cant afford|over budget|kinda steep|thats a lot)\b/i,
  /\b(?:is this (?:a scam|legit|real)|sketchy|too good to be true)\b/i,
  /^(?:ok|k|bet|word|yea|yeah|yep|yup|sure|for sure|fs|aight|cool|np|sounds good|got it|gotcha)\.?\s*$/i,
];

export type GuardrailInput = {
  candidate: string;
  linkSendCountBefore: number;
  /** True if this is the first assistant message in the conversation. */
  isFirstMessage: boolean;
  /** Prior assistant messages in this conversation (for repeat detection). */
  priorAssistantMessages?: string[];
  /** The inbound message the bot is replying to (for soft-turn detection). */
  inboundText?: string;
  /** Lengths of recent assistant messages (for rhythm variance check). */
  priorAssistantLengths?: number[];
};

export type GuardrailResult =
  | { ok: true; clean: string; linkSentThisTurn: boolean; violations: string[] }
  | { ok: false; reason: string; violations: string[] };

export function applyGuardrail(input: GuardrailInput): GuardrailResult {
  const violations: string[] = [];
  let text = input.candidate.trim();

  // 1. Strip dashes. Replace em/en-class with comma-space, soften
  //    letter-hyphen-letter to space. Preserve URL hyphens (URLs are
  //    extremely rare in bot output; only secure.springbreaku.com links
  //    which use upper-case codes without hyphens).
  text = text.replace(DASH_CHARS, ', ');
  text = text.replace(/([A-Za-z])-([A-Za-z])/g, '$1 $2');
  text = text
    .replace(/ ,/g, ',')
    .replace(/,\s+,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 2. Normalize rep name variants to "Spiffy". Cheap rewrite, not a
  //    reject. Handles the case where the LLM tries "Derrick".
  for (const rx of NAME_VARIANTS) {
    const before = text;
    text = text.replace(rx, CANONICAL_NAME);
    if (text !== before) violations.push('normalized_rep_name');
  }

  // 3. Strip emoji anywhere. Spiffy uses zero.
  {
    const hadEmoji = EMOJI_REGEX.test(text);
    if (hadEmoji) {
      violations.push('stripped_emoji');
      text = text.replace(EMOJI_REGEX, '').replace(/\s{2,}/g, ' ').trim();
    }
  }

  // 3b. Strip summary labels. Spiffy never prefaces answers with a
  //     label. Rewrite rather than reject so we keep the payload.
  {
    const before = text;
    text = text.replace(
      /^(?:\s*)(short version|quick version|quick summary|tl;?dr|in short|to sum up|in summary|long story short|the short answer)\s*[:,\-]\s*/i,
      '',
    );
    text = text.replace(
      /([.!?\n]\s+)(short version|quick version|quick summary|tl;?dr|in short|to sum up|in summary|long story short|the short answer)\s*[:,\-]\s*/gi,
      '$1',
    );
    if (text !== before) {
      violations.push('stripped_ai_summary_label');
      // Do NOT force-capitalize after strip; Spiffy starts lowercase
      // ~40% of the time, and forcing case would break voice.
    }
  }

  // 4. Banned openers -> regenerate.
  for (const rx of BANNED_OPENERS) {
    if (rx.test(text)) {
      return {
        ok: false,
        reason: `banned opener: ${rx}`,
        violations: [...violations, 'banned_opener'],
      };
    }
  }

  // 4b. Banned phrases anywhere -> regenerate.
  for (const rx of BANNED_PHRASES) {
    if (rx.test(text)) {
      return {
        ok: false,
        reason: `banned phrase: ${rx}`,
        violations: [...violations, 'banned_phrase'],
      };
    }
  }

  // 4c. AI-tell phrases: soft-cap at 1 per conversation. If this
  //     message AND any prior assistant message both contain the same
  //     phrase, reject (force Spiffy to find another beat).
  if (input.priorAssistantMessages && input.priorAssistantMessages.length > 0) {
    for (const tell of AI_TELL_PATTERNS) {
      if (tell.rx.test(text)) {
        const priorUsed = input.priorAssistantMessages.some((m) => tell.rx.test(m));
        if (priorUsed) {
          return {
            ok: false,
            reason: `over-used ai-tell phrase: ${tell.name} (already used earlier in thread)`,
            violations: [...violations, `repeated_ai_tell:${tell.name}`],
          };
        }
      }
    }
  }

  // 4d. Compound question check. A "?" followed by a declarative answer
  //     is treated as rhetorical (Spiffy pattern: "honest take? Punta
  //     Cana all day."). Only >=2 REAL answer-seeking questions = reject.
  const realQuestionCount = countRealQuestions(text);
  if (realQuestionCount >= 2) {
    return {
      ok: false,
      reason: `compound question (${realQuestionCount} answer-seeking questions in one message)`,
      violations: [...violations, 'compound_question'],
    };
  }

  // 4e. Qualifier-repeat guard. If the bot has already asked the same
  //     qualifier family twice without the lead answering, a 3rd ask is
  //     form-field behavior. Reject with a retry nudge.
  if (input.priorAssistantMessages && input.priorAssistantMessages.length > 0) {
    for (const fam of QUALIFIER_FAMILIES) {
      if (fam.rx.test(text)) {
        const priorAsks = input.priorAssistantMessages.filter((m) => fam.rx.test(m)).length;
        if (priorAsks >= 2) {
          return {
            ok: false,
            reason: `qualifier re-ask: ${fam.name} has already been asked ${priorAsks} times without an answer, dont re-ask, shift angle or work with what you have`,
            violations: [...violations, `qualifier_repeat:${fam.name}`],
          };
        }
      }
    }
  }

  // 5. Staff names -> regenerate.
  for (const name of STAFF_NAMES) {
    const rx = new RegExp(`\\b${name}\\b`);
    if (rx.test(text)) {
      return {
        ok: false,
        reason: `named staff member: ${name}`,
        violations: [...violations, 'named_staff'],
      };
    }
  }

  // 5b. Hallucinated reservation link -> regenerate. The bot should
  //     never produce /package/[CODE] — Spiffy's back office injects
  //     those. If the LLM emits one it's inventing.
  if (HALLUCINATED_LINK_PATTERN.test(text)) {
    return {
      ok: false,
      reason: 'hallucinated reservation link (LLM cannot generate package codes)',
      violations: [...violations, 'hallucinated_link'],
    };
  }

  // 6. Link-budget check. No generic booking link for Spiffy bot in
  //    V1 since links are per-group and injected by ops. But we keep
  //    the budget machinery in case a link gets injected via turn
  //    context — counts any http(s):// URL toward budget to catch
  //    whatever path gets wired up in the future.
  const GENERIC_LINK = /https?:\/\/\S+/i;
  const linkPresent = GENERIC_LINK.test(text);
  if (linkPresent && input.linkSendCountBefore >= 2) {
    return {
      ok: false,
      reason: 'link budget exhausted',
      violations: [...violations, 'link_budget_exceeded'],
    };
  }

  // 7. Length cap. SMS-friendly. Spiffy's real median is much lower,
  //    this is a safety net.
  const HARD_CAP = 450;
  if (text.length > HARD_CAP) {
    violations.push('too_long_trimmed');
    text = trimPreservingBridge(text, 3, HARD_CAP);
  }

  // 8. Qualifier-tack-on guard. If the inbound was a soft turn
  //    (objection, stall, thanks, one-word reply), the bot should NOT
  //    end with a qualifier question. Spiffy just responds and stops.
  //    This is the #1 bot tell when it fires.
  if (input.inboundText) {
    const isSoftTurn = SOFT_TURN_INBOUND.some((rx) => rx.test(input.inboundText!));
    if (isSoftTurn) {
      const endsWithQualifier = QUALIFIER_FAMILIES.some((fam) => fam.rx.test(text));
      if (endsWithQualifier) {
        return {
          ok: false,
          reason: 'qualifier tacked onto a soft turn (objection/thanks/stall/one-word). just respond and stop, dont ask a qualifier here',
          violations: [...violations, 'qualifier_on_soft_turn'],
        };
      }
    }
  }

  // 9. Apostrophe density rewrite. Spiffy drops apostrophes ~40% of
  //    the time ("thats", "ill", "im", "dont"). If too many
  //    contractions have apostrophes the text reads too proper.
  //    Rewrite, don't reject — this is voice polish, not a rule break.
  {
    const contractionsWithApostrophe = (text.match(/\b(?:I'm|it's|that's|there's|I'll|don't|can't|won't|wouldn't|couldn't|isn't|aren't|didn't|doesn't|haven't|hasn't|we've|they've|you've|I've|we're|they're|you're|he's|she's|what's|who's|let's)\b/gi) ?? []);
    if (contractionsWithApostrophe.length >= 3) {
      // Drop apostrophes on roughly half, favoring the ones Spiffy
      // drops most (thats, ill, im, dont, cant, its, theres, wont).
      const dropMap: Record<string, string> = {
        "I'm": "im", "i'm": "im",
        "it's": "its", "It's": "its",
        "that's": "thats", "That's": "thats",
        "there's": "theres", "There's": "theres",
        "I'll": "ill", "i'll": "ill",
        "don't": "dont", "Don't": "dont",
        "can't": "cant", "Can't": "cant",
        "won't": "wont", "Won't": "wont",
        "wouldn't": "wouldnt", "Wouldn't": "wouldnt",
        "didn't": "didnt", "Didn't": "didnt",
        "doesn't": "doesnt", "Doesn't": "doesnt",
        "isn't": "isnt", "Isn't": "isnt",
        "aren't": "arent", "Aren't": "arent",
        "we've": "weve", "We've": "weve",
        "they've": "theyve",
        "you've": "youve",
        "I've": "ive",
        "we're": "were", "We're": "were",
        "they're": "theyre",
        "you're": "youre", "You're": "youre",
        "let's": "lets", "Let's": "lets",
        "what's": "whats", "What's": "whats",
      };
      let dropCount = 0;
      text = text.replace(/\b(?:I'm|it's|that's|there's|I'll|don't|can't|won't|wouldn't|couldn't|isn't|aren't|didn't|doesn't|haven't|hasn't|we've|they've|you've|I've|we're|they're|you're|he's|she's|what's|who's|let's)\b/gi, (match) => {
        // Drop ~50% of apostrophes, alternating.
        dropCount++;
        if (dropCount % 2 === 0) return match; // keep every other one
        return dropMap[match] ?? match;
      });
      if (dropCount > 0) violations.push('softened_apostrophes');
    }
  }

  // 10. Rhythm variance. If the last 3 assistant messages were all in
  //     the same length band (within 40 chars of each other), the bot
  //     has fallen into a rigid rhythm. Reject to force variation.
  if (input.priorAssistantLengths && input.priorAssistantLengths.length >= 2) {
    const recent = input.priorAssistantLengths.slice(-2);
    const currentLen = text.length;
    const allLengths = [...recent, currentLen];
    const minLen = Math.min(...allLengths);
    const maxLen = Math.max(...allLengths);
    // If all 3 messages are within a 40-char band AND all > 60 chars,
    // that's the robotic 2-3 sentence rhythm. Short replies ("bet",
    // "word") naturally break the pattern.
    if (maxLen - minLen < 40 && minLen > 60) {
      return {
        ok: false,
        reason: 'rhythm is too uniform, last 3 replies are all similar length. vary it up, go shorter or longer than usual',
        violations: [...violations, 'uniform_rhythm'],
      };
    }
  }

  return {
    ok: true,
    clean: text,
    linkSentThisTurn: linkPresent,
    violations,
  };
}

function trimPreservingBridge(text: string, maxSentences: number, maxChars: number): string {
  const parts = (text.match(/[^.!?]+[.!?]?/g) ?? [text])
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= maxSentences && text.length <= maxChars) return text;

  if (parts.length <= 2) {
    return text.slice(0, maxChars).trim();
  }

  const first = parts[0];
  const last = parts[parts.length - 1];
  const middles = parts.slice(1, -1);

  let kept = `${first} ${last}`;
  if (kept.length <= maxChars && maxSentences >= 2) {
    for (const m of middles) {
      const candidate = `${first} ${m} ${last}`;
      if (candidate.length <= maxChars) kept = candidate;
      else break;
    }
    return kept;
  }

  const budget = maxChars - last.length - 1;
  if (budget > 40) {
    return `${first.slice(0, budget).trim()} ${last}`;
  }
  return last;
}
