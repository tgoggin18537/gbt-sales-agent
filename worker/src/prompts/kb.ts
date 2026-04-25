/**
 * SpringBreak U / Go Blue Tours knowledge base.
 *
 * Every fact here is grounded in the Sakari transcript corpus
 * (151 booked conversations) or the SPRING BREAK AI SALES BRAIN doc.
 * Conflicts between the two were resolved in favor of transcript
 * evidence — see SPIFFY_V2_QUESTIONS.md for the confirmation list.
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
    // Spiffy personally travels to Punta Cana for spring break. Real
    // fact from the transcripts — he tells leads "thats where ill be too".
    onSiteDestination: 'Punta Cana',
  },
  destinations: [
    {
      name: 'Punta Cana',
      country: 'Dominican Republic',
      hotels: [
        { name: 'Occidental Punta Cana', notes: '#1 most popular, best balance, Spiffy is on-site here' },
        { name: 'Occidental Caribe', notes: 'same chain, different resort, less popular' },
        { name: 'Riu Republica', notes: 'requires ONE 21+ per room, max 3 per room' },
      ],
      vibe: 'college party, best balance, most popular',
      pricingTier: 'cheapest',
    },
    {
      name: 'Cancun',
      country: 'Mexico',
      hotels: [
        { name: 'Grand Oasis', notes: 'popular, solid' },
        { name: 'Krystal', notes: 'on-site staff presence' },
        { name: 'Riu Caribe', notes: 'also referred to as Riu Cancun in some threads' },
      ],
      vibe: 'lit, mid tier, solid',
      pricingTier: 'mid',
    },
    {
      name: 'Cabo',
      country: 'Mexico',
      hotels: [
        { name: 'Riu Santa Fe', notes: 'requires ONE 21+ per room' },
        { name: 'Tesoro', notes: '18+ across the board, no 21+ requirement' },
      ],
      vibe: 'a vibe, def more on the expensive side but worth it',
      pricingTier: 'expensive',
    },
    {
      name: 'Nassau',
      country: 'Bahamas',
      hotels: [{ name: 'Breezes', notes: 'all inclusive, chill' }],
      vibe: 'chill, less party-heavy',
      pricingTier: 'premium',
    },
    {
      name: 'Fort Lauderdale',
      country: 'USA',
      hotels: [],
      vibe: 'domestic option, no transcript data on vibe',
      pricingTier: 'varies',
    },
  ],
  pricing: {
    // Transcript-confirmed. KB doc said $50 but Spiffy quotes $200 in
    // 92+ conversations. Late-joiner variant is $100. See V2 questions.
    depositStandard: 200,
    depositLateJoinerVariant: 100,
    // From transcripts — Spiffy's canonical phrasing.
    finalBalanceRule: 'approximately 2 weeks from deposit, exact date depends on travel date',
    partyPass: {
      threeNight: 210,
      fourNight: 269,
      fiveNight: 299,
      bundleThreeEventPromo: 200,
    },
    groupLeaderFreeThreshold: 15,
    roomMaxStandard: 4,
    roomMaxRiuRepublica: 3,
    flightsIncluded: false,
    flightsNote:
      'Customers book their own flights. It is cheaper separately. Spiffy can help find good flights via Google Flights links.',
    travelInsurance: {
      provider: 'Travel Insured',
      coverage: 'up to 75% of payments, Cancel For Any Reason (CFAR)',
      priceRange: '$50 to $150 depending on state',
    },
  },
  policies: {
    ageRequirement: {
      twentyOnePlusRequired: ['Riu Republica', 'Riu Santa Fe'],
      eighteenPlusDefault: true,
      note: 'At Riu Republica and Riu Santa Fe, ONE person per room must be 21+ for check-in. All other resorts 18+ across the board.',
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
    partyPassIncludes: [
      'round-trip coach bus transportation',
      'express entry at off-resort nightclub events',
      'cover charge covered',
      'open bar at off-resort nightclub events',
      'typically includes the booze cruise event',
    ],
    excursionsHandling:
      'SpringBreak U only handles party pass and booze cruise. ATVs, jet skis, tours, snorkeling, etc. are booked at the resort concierge desk on arrival.',
    cancellationPolicy:
      'Once deposited, cancellation is only refundable via the Travel Insured CFAR policy (if the lead opted in during deposit). No refunds outside that.',
  },
  reservationLink: {
    urlFormat: 'secure.springbreaku.com/site/public/package/[CODE]',
    // The bot does NOT generate codes. Spiffy's back office produces
    // the link. Bot only sends a link when the server injects one.
    botCanGenerate: false,
    maxSendsPerConversation: 2,
  },
  bot: {
    mode: 'setter', // V1 = inbound qualifier + deposit driver.
    primaryNumber: '', // V2 questions: confirm SMS number for carrier context.
    voiceReference: 'Match Spiffy (Derrick Darko) verbatim. See prompts/spiffy.ts.',
  },
  // Placeholder tag list. V2: replace with the real tag set from
  // Spiffy's GHL location. Current guesses based on playbook defaults
  // and common SpringBreakU states.
  existingCustomerTags: [
    'customer',
    'booked',
    'traveler',
    'deposited',
    'call-booked',
    'existing-customer',
  ],
  // Carrier-blocked phrases Spiffy has observed hitting 30007 blocks.
  // None observed in current corpus (not a wellness brand). Leave open
  // for V2 additions.
  carrierBlockedPatterns: [] as string[],
} as const;

/**
 * Plain-string list of phrases Spiffy must never use (sourced from
 * spiffy-v2-spec.md section 4). Exported so the system prompt can
 * reference them explicitly, making the model aware at inference time.
 * The guardrail in agents/guardrail.ts enforces these as regex patterns.
 */
export const SPIFFY_BANNED_PHRASES: readonly string[] = [
  // Overly salesy
  'Limited time offer, act now',
  "Don't miss out",
  "Book now before it's too late",
  // Robotic / corporate
  'Thank you for your inquiry',
  'We appreciate your interest in our services',
  'Per our previous message',
  'Kindly review the following',
] as const;

export function hasExistingCustomerTag(tags: string[] | undefined | null): boolean {
  if (!tags || tags.length === 0) return false;
  const lowered = tags.map((t) => t.toLowerCase());
  return GBT_KB.existingCustomerTags.some((t) => lowered.includes(t.toLowerCase()));
}
