/**
 * Mesa Lab's settings, from the environment. Every limit has a safe default;
 * the agent does nothing at all until LAB_ENABLED=1 and an OpenRouter key is set.
 */
const env = process.env
const num = (k: string, d: number) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d)

export const config = {
  enabled: env.LAB_ENABLED === '1',
  dataDir: env.LAB_DATA ?? './data',
  port: num('PORT', 8095),
  /** Where the apps are served; the token's website points here. */
  publicUrl: (env.LAB_PUBLIC_URL ?? 'https://api.mesa.cx/lab').replace(/\/$/, ''),
  /** Internal address of the market service, for image uploads. */
  uploadUrl: env.LAB_UPLOAD_URL ?? 'http://market:8085/upload',
  openrouterKey: env.OPENROUTER_API_KEY?.trim() ?? '',
  model: env.LAB_MODEL ?? 'anthropic/claude-sonnet-5.5',
  reviewModel: env.LAB_REVIEW_MODEL ?? 'anthropic/claude-haiku-5.5',
  /** Hard caps. */
  maxPerDay: num('LAB_MAX_PER_DAY', 2),
  gapHours: num('LAB_GAP_HOURS', 8),
  maxTotal: num('LAB_MAX_TOTAL', 60),
  budgetUsdPerDay: num('LAB_BUDGET_USD', 3),
  minHype: num('LAB_MIN_HYPE', 0.002),
  /** Launch settings for every token. */
  feePct: num('LAB_FEE_PCT', 2),
  sniperPct: num('LAB_SNIPER_PCT', 10),
  snipeSeconds: num('LAB_SNIPE_SECONDS', 60),
  /** Claim fees once they reach this much HYPE, at most once a day. */
  claimAt: num('LAB_CLAIM_AT', 0.01),
  /** Testing: no launches, posts or claims (LAB_DRY_RUN=1), canned model answers (LAB_MOCK=1). */
  dryRun: env.LAB_DRY_RUN === '1',
  mock: env.LAB_MOCK === '1',
}
