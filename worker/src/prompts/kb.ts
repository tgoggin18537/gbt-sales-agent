/**
 * SpringBreak U / Go Blue Tours knowledge base.
 *
 * V5 (May 4, 2026) rebuild. Every fact in this file is grounded in:
 *   1. Sakari transcript corpus (151 booked conversations)
 *   2. SPRING BREAK AI SALES BRAIN doc
 *   3. Spiffy's V5 revision document (~/Desktop/Spring Break Bot_Feedback_ May 4.pdf)
 *
 * V5 corrections from the revision doc:
 *   - Per-resort accuracy blocks (Section 3.1)
 *   - Per-destination party pass pricing (Section 3.2)
 *   - Cancun party pass = $1 trolley, NOT coach bus (Section 1.9 + 3.2)
 *   - Krystal Cancun is CHILL, do NOT describe as party resort (Section 3.1)
 *   - Group leader free trip = 15 fully PAID, not deposited (Section 1.6)
 *   - Deposit structure: early season $100, late season $200, late joiner rule (Section 3.2)
 *   - Beds: 2 doubles standard, no hedging (Section 3.4)
 *   - Travel insurance: defer to Travel Insured directly, never "let me check" (Section 3.2)
 *   - Email contains breakdown/pricing/booking links, NEVER call it a PDF (Section 3.5)
 *   - Spiffy on-the-ground only at Punta Cana, never multi-destination (Section 6 checklist)
 *
 * Conflicts resolved in favor of revision doc when newer than transcript evidence.
 */

export const GBT_KB = {
  brand: {
    primary: 'SpringBreak U',
    parent: 'Go Blue Tours',
    // Default voice. Bot only switches to "Go Blue Tours" when lead
    // references that brand first.
    botSaysBrandAs: 'SpringBreak U',
    website: 'springbreaku.com',
  },
  rep: {
    canonicalName: 'Spiffy',
    realName: 'Derrick Darko',
    // Spiffy personally travels to PUNTA CANA only. Never claim
    // on-the-ground at multiple destinations (V5 checklist item).
    onSiteDestination: 'Punta Cana',
    onSiteResort: 'Occidental Punta Cana',
  },

  /**
   * Full per-resort blocks. Source: V5 revision doc Section 3.1.
   * Bot uses these as ground truth for any resort-level question.
   */
  destinations: [
    {
      name: 'Punta Cana',
      country: 'Dominican Republic',
      vibe: 'college party, best balance, most popular',
      pricingTier: 'cheapest to mid',
      transportation: 'round-trip coach bus included with party pass',
      hotels: [
        {
          name: 'Occidental Punta Cana',
          checkInAge: 18,
          maxPerRoom: 4,
          isPartyResort: true,
          notes: [
            '#1 most sold destination (73% of all bookings)',
            'best balance of price + party + quality',
            'on-resort nightclub: Mangu Disco, small but gets lit',
            'late-night snack bar open until ~5-6am (tacos/pizza), social spot after clubs',
            'specialty restaurants: Italian, Mexican, Steakhouse, Seafood (reserve on arrival)',
            'Spiffy is personally here during spring break season',
            'under-18 needs parent/guardian signoff',
          ],
        },
        {
          name: 'Riu Republica',
          checkInAge: 21,
          maxPerRoom: 3,
          isPartyResort: true,
          notes: [
            '21+ requirement during spring break: ONE per room must be 21+, most others should be 20+',
            'premium resort, hosts Riu Parties (Pink, White, Jungle, Neon)',
            'more adult/mixed crowd, NOT the heavy college vibe of Occidental',
            'beachfront, bigger rooms, better food than average',
          ],
        },
        {
          name: 'Occidental Caribe',
          checkInAge: 18,
          maxPerRoom: 4,
          isPartyResort: false,
          notes: ['same Occidental chain, less popular than Occidental Punta Cana'],
        },
      ],
    },
    {
      name: 'Cancun',
      country: 'Mexico',
      vibe: 'iconic spring break destination, mid-tier pricing',
      pricingTier: 'mid',
      // CRITICAL V5 CORRECTION: Cancun is NOT coach bus. Everyone takes
      // the $1 trolley. NEVER describe Cancun party pass transport as
      // a coach bus. Section 1.9 of the revision doc.
      transportation:
        '$1 trolley picks up in front of resort, cycles every ~15 min, ~5-mile ride to party center, $1 each way. NOT included in party pass, everyone uses it, super easy.',
      hotels: [
        {
          name: 'Grand Oasis',
          checkInAge: 18,
          maxPerRoom: 4,
          isPartyResort: true,
          notes: [
            'most iconic spring break resort in the world, IT is the party',
            'quarter-mile pool, day club with big stage, 1,200+ rooms',
            'food and rooms are basic, not luxury, that is not the point',
            'small on-resort nightclub',
            'party pass transport: $1 trolley NOT a coach bus, picks up out front, cycles every 15 min',
          ],
        },
        {
          name: 'Krystal',
          checkInAge: 18,
          maxPerRoom: 4,
          // V5 CORRECTION: Krystal is CHILL, not a party resort.
          // Section 3.1 explicitly flags this.
          isPartyResort: false,
          notes: [
            'CHILL vibe, NOT a party resort (this was flagged in V4 testing)',
            'nicer than Grand Oasis: cleaner, better food, better rooms',
            'less than 5 min walk from Cancun party center nightclubs',
            'no big on-resort parties, no DJ events',
            'good for groups that want nightlife access without living in chaos',
          ],
        },
        {
          name: 'Riu Caribe',
          checkInAge: 21,
          maxPerRoom: 4,
          isPartyResort: true,
          notes: [
            '21+ requirement during spring break (same as Republica)',
            'hosts Riu Parties, same themed events as Republica',
            'push Riu Caribe over Riu Cancun, Caribe is more of a party resort',
            'more expensive, many prospects switch to Grand O or Krystal when they see pricing',
            'sometimes called Riu Cancun in older threads',
          ],
        },
      ],
    },
    {
      name: 'Cabo',
      country: 'Mexico',
      vibe: 'a vibe, more expensive but worth it',
      pricingTier: 'expensive',
      transportation: 'short taxi ride to downtown Cabo nightlife',
      hotels: [
        {
          name: 'Riu Santa Fe',
          checkInAge: 21,
          maxPerRoom: 4,
          isPartyResort: true,
          notes: [
            '21+ requirement during spring break',
            'most expensive of all our options: $1,000-$1,300/person',
            '1,200+ rooms, multiple pools, huge production Riu Parties',
            'feels like a college campus party in paradise',
            'small on-resort nightclub (not great but functional)',
          ],
        },
        {
          name: 'Tesoro',
          checkInAge: 18,
          maxPerRoom: 4,
          isPartyResort: false,
          notes: [
            '18+ across the board, no 21+ requirement',
            'marina-view hotel (yachts outside), rooftop pool',
            'more hotel-style than resort, less college-party vibe',
            'pushed as secondary option when Riu Santa Fe doesnt fit (mostly under-21 groups)',
          ],
        },
      ],
    },
    {
      name: 'Nassau',
      country: 'Bahamas',
      vibe: 'chill, less party-heavy',
      pricingTier: 'premium',
      transportation: 'arranged on-site',
      hotels: [
        {
          name: 'Breezes',
          checkInAge: 18,
          maxPerRoom: 4,
          isPartyResort: false,
          notes: [
            'all-inclusive, chill',
            'mixed crowd: college students, families, older travelers',
            'more chill than Punta Cana or Cancun, NOT party-focused',
            'offered as alternative for safety-conscious prospects or those who cant go to Mexico/DR',
            'specific date ranges only, do not quote open-ended availability',
          ],
        },
      ],
    },
    {
      name: 'Fort Lauderdale',
      country: 'USA',
      // V5 CORRECTION: NOT all-inclusive. NOT a resort. Critical fact.
      vibe: 'domestic option, nightlife/events focused (off-resort)',
      pricingTier: 'varies',
      transportation: 'whatever transit/uber leads use locally',
      hotels: [
        {
          name: 'Tru by Hilton',
          checkInAge: 18,
          maxPerRoom: 4,
          isPartyResort: false,
          notes: [
            'NOT all-inclusive (this is critical)',
            'standard hotel style, not a resort',
            'domestic option for those who dont want to travel internationally',
            'nightlife/events focused destination, not hotel focused',
            'do not pitch as main option, only when requested or international doesnt work',
          ],
        },
      ],
    },
  ],

  /**
   * Pricing. V5 revision doc Section 3.2.
   * Deposit structure now seasonal. Party pass priced per destination.
   */
  pricing: {
    deposit: {
      // Early season (spring/summer): $100 deposit, then $100/month installments,
      // final balance due in December.
      earlySeasonStandard: 100,
      earlySeasonInstallment: 100,
      earlySeasonFinalBalanceDue: 'December',

      // Late season (fall/winter): $200 deposit, larger installments,
      // final balance due mid-December.
      lateSeasonStandard: 200,
      lateSeasonFinalBalanceDue: 'mid-December',

      // Standard current deposit: $100 per person (may vary by promo).
      currentStandard: 100,

      // Late joiner rule: new member pays current deposit PLUS catches
      // up to whatever installment stage the group is already at, at
      // current pricing.
      lateJoinerRule:
        'pays current deposit, then catches up to the groups current installment stage at current pricing',
    },

    finalBalanceRule:
      'remaining balance is paid via monthly installments, schedule depends on travel date and when you join',

    /**
     * Party pass priced PER DESTINATION. V5 Section 3.2.
     * Punta Cana sells per-event. Cancun sells per-night packages.
     * Cabo sells per-event. Nassau sells one bundle.
     */
    partyPass: {
      puntaCana: {
        cocoBongo: 79,
        imagineCave: 89,
        imagineCaveNote: 'literally inside a cave, mention it, great selling point',
        pearlBeachClub: 69,
        marocaNightclub: 69,
        boozeCruise: 75,
        threeEventBundle: 210,
        threeEventBundleNote: 'best value, typically 2 nightclubs + booze cruise',
      },
      cancun: {
        threeNightPackage: 210,
        fourNightPackage: 269,
        fiveNightPackage: 299,
        boozeCruiseStandalone: 79,
        // Transportation NOT included. Everyone uses the $1 trolley.
        transportNote:
          '$1 trolley picks up in front of resort, NOT included in pass, everyone uses it, super easy',
      },
      cabo: {
        squidRoe: 75,
        mandala: 65,
        laVaquita: 65,
        boozeCruise: 75,
        threeEventBundle: 210,
      },
      nassau: {
        fourEventBundle: 289,
      },
    },

    /**
     * Group leader free trip. V5 Section 1.6 CORRECTION.
     * Was: "15 deposits triggers free trip" — WRONG.
     * Is: "15 travelers complete FULL PAYMENT to trigger free trip."
     */
    groupLeaderFreeTrip: {
      threshold: 15,
      // CRITICAL: full payment, not deposit.
      requiresFullPayment: true,
      framing:
        'once 15 travelers finish paying, your trip gets comped, your payments get reimbursed and final balance waived if any',
      note: 'deposits count toward building the group but do NOT trigger the free trip',
    },

    flightsIncluded: false,
    flightsNote:
      'flights NOT included, cheaper to book separately (saves $150-$200), Spiffy can help find good options via Google Flights',
    flightsAirportCodes: {
      puntaCana: 'PUJ',
      cancun: 'CUN',
      cabo: 'SJD',
      nassau: 'NAS',
      fortLauderdale: 'FLL',
    },

    /**
     * Travel insurance. V5 Section 3.2 CORRECTION.
     * Bot does NOT have access to exact state pricing. Defer to Travel
     * Insured site directly. Never say "let me check on that."
     */
    travelInsurance: {
      provider: 'Travel Insured International',
      coverage: 'up to 75% reimbursement, Cancel For Any Reason (CFAR)',
      priceRange: '$50 to $150 per person depending on state and policy type',
      pricingDeferral:
        'exact pricing is set by Travel Insured directly, you can check their site when you deposit, it walks you through it',
      // Anti-pattern: NEVER use this phrase for insurance pricing.
      bannedPhrase: 'let me check on that',
    },
  },

  /**
   * Room beds. V5 Section 3.4.
   * No hedging, no "let me check, usually 2 queens." It is 2 doubles.
   */
  rooms: {
    bedsStandard: '2 double beds',
    bedSizeNote: 'a double is between a queen and a full, 4 people fit easy',
    maxPerRoomStandard: 4,
    maxPerRoomRiuRepublica: 3,
  },

  policies: {
    ageRequirement: {
      twentyOnePlusRequired: ['Riu Republica', 'Riu Santa Fe', 'Riu Caribe'],
      eighteenPlusDefault: true,
      note: 'At 21+ resorts, ONE person per room must be 21+ for check-in. All other resorts 18+ across the board.',
    },

    includedInBasePackage: [
      'all-inclusive resort stay (4 or 5 nights)',
      'unlimited food on resort',
      'unlimited drinks on resort',
      'round-trip airport transfers',
      'all on-resort parties and events (pool party, beach party, on-resort nightclub)',
      '24/7 on-site staff support',
      'all government taxes and fees',
    ],

    /**
     * Party pass inclusions. V5 corrects the transport language per
     * destination (Cancun = $1 trolley not coach bus).
     */
    partyPassIncludes: {
      common: [
        'express entry at off-resort nightclub events',
        'cover charge covered',
        'open bar at off-resort nightclub events',
        'typically includes the booze cruise event',
      ],
      transportByDestination: {
        puntaCana: 'round-trip coach bus transportation included',
        cancun:
          'NO coach bus, $1 trolley each way (everyone uses it), NOT included in pass but super easy',
        cabo: 'short taxi ride to downtown Cabo (varies by group)',
        nassau: 'arranged on-site',
      },
    },

    excursionsHandling:
      'SpringBreak U only handles party pass and booze cruise. ATVs, jet skis, tours, snorkeling, etc. are booked at the resort concierge desk on arrival.',

    cancellationPolicy:
      'Once deposited, cancellation is only refundable via the Travel Insured CFAR policy (if the lead opted in during deposit). No refunds outside that.',
  },

  /**
   * Email handoff. V5 Section 3.5 CORRECTION.
   * NEVER call it a PDF. Describe what it actually contains.
   */
  email: {
    description: 'email with the full breakdown, pricing, and booking links',
    contains: [
      'full package breakdown',
      'pricing by room occupancy (2, 3, or 4 per room)',
      'whats included',
      'payment plan details',
      'links to booking/quote',
      'add-on options (party pass, insurance)',
    ],
    // Anti-pattern: NEVER describe email as a PDF.
    bannedDescription: 'PDF',
  },

  reservationLink: {
    urlFormat: 'secure.springbreaku.com/site/public/package/[CODE]',
    // The bot does NOT generate codes. Spiffy's back office produces
    // the link. Bot only sends a link when the server injects one.
    botCanGenerate: false,
    maxSendsPerConversation: 2,
  },

  /**
   * Spring break week intelligence. Phase 2 enhancement (4.4) but
   * documented here so when phase 2 ships the data is ready.
   */
  springBreakWeeks: {
    week1: 'Feb 27 to Mar 5',
    week2: 'Mar 6 to Mar 12',
    week3: 'Mar 13 to Mar 19',
    week4: 'Mar 20 to Mar 26',
    shoulder: 'late March into early April',
  },

  bot: {
    mode: 'setter', // V1-V5 = inbound qualifier + email/deposit driver.
    primaryNumber: '',
    voiceReference: 'Match Spiffy (Derrick Darko) verbatim. See prompts/spiffy.ts.',
  },

  /**
   * Tags that mark a contact as already-purchased / existing customer.
   * The bot disengages on these so we dont SMS active travelers.
   */
  existingCustomerTags: [
    'customer',
    'booked',
    'traveler',
    'deposited',
    'call-booked',
    'existing-customer',
  ],

  // Carrier-blocked phrases observed hitting 30007 blocks.
  // None observed in current corpus (not a wellness brand). Leave open
  // for future additions.
  carrierBlockedPatterns: [] as string[],
} as const;

/**
 * Phrases Spiffy must never use (V2 spec section 4 + V5 revision additions).
 * The guardrail at agents/guardrail.ts enforces these as regex patterns.
 * This export is kept for the system prompt to reference at inference time.
 */
export const SPIFFY_BANNED_PHRASES: readonly string[] = [
  // ---- V2 BANNED (overly salesy) ----
  'Limited time offer, act now',
  "Don't miss out",
  "Book now before it's too late",
  // ---- V2 BANNED (robotic / corporate) ----
  'Thank you for your inquiry',
  'We appreciate your interest in our services',
  'Per our previous message',
  'Kindly review the following',

  // ---- V5 BANNED (revision doc additions) ----
  // Section 1.2: handoff announcement reveals the bot.
  'lemme have someone from our team jump in',
  'someone from our team will jump in',

  // Section 1.3: cold email asks. Always soften.
  "What's your email?",

  // Section 2.3: confused-thinking response from V4 testing.
  'hmm good one let me think on that real quick',

  // Section 3.2: insurance pricing deferral. We do NOT have access.
  'let me check on that and circle back', // for insurance and beds

  // Section 3.4: beds hedging.
  'usually its 2 queens but depends on the resort',

  // Section 3.5: email is NOT a PDF.
  'all I do is send you a PDF',
  'send you a PDF',

  // Section 1.9: Cancun does NOT use a coach bus.
  // (regex-style bot will catch by context — listed here as a string for
  // human readers and to seed the guardrail update.)
] as const;

export function hasExistingCustomerTag(tags: string[] | undefined | null): boolean {
  if (!tags || tags.length === 0) return false;
  const lowered = tags.map((t) => t.toLowerCase());
  return GBT_KB.existingCustomerTags.some((t) => lowered.includes(t.toLowerCase()));
}
