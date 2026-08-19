/**
 * Tiered Sourcing Configuration
 * Tier 1: Direct ATS APIs (Greenhouse, Lever, Ashby - fast, structured, no auth)
 * Tier 2: Open / Licensed Job Board APIs (RemoteOK, Arbeitnow, Jobicy)
 * Tier 3 hostile aggregators are design-only and intentionally have no live config.
 */

export const DEFAULT_SOURCES = [
  // Tier 1 — Direct ATS APIs (Structured JSON, No Auth, Zero Ban Risk)
  {
    id: 'greenhouse_figma',
    name: 'Greenhouse - Figma',
    type: 'ats_greenhouse',
    tier: 1,
    endpoint: 'https://boards-api.greenhouse.io/v1/boards/figma/jobs',
    enabled: true,
    rate_limit_ms: 500
  },
  {
    id: 'greenhouse_cloudflare',
    name: 'Greenhouse - Cloudflare',
    type: 'ats_greenhouse',
    tier: 1,
    endpoint: 'https://boards-api.greenhouse.io/v1/boards/cloudflare/jobs',
    enabled: true,
    rate_limit_ms: 500
  },
  {
    id: 'greenhouse_stripe',
    name: 'Greenhouse - Stripe',
    type: 'ats_greenhouse',
    tier: 1,
    endpoint: 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs',
    enabled: true,
    rate_limit_ms: 500
  },
  {
    id: 'greenhouse_discord',
    name: 'Greenhouse - Discord',
    type: 'ats_greenhouse',
    tier: 1,
    endpoint: 'https://boards-api.greenhouse.io/v1/boards/discord/jobs',
    enabled: true,
    rate_limit_ms: 500
  },

  // Tier 2 — Open / Integration-Friendly Public Job Board APIs
  {
    id: 'remoteok',
    name: 'RemoteOK Open API',
    type: 'public_api_remoteok',
    tier: 2,
    endpoint: 'https://remoteok.com/api',
    enabled: true,
    rate_limit_ms: 1200
  },
  {
    id: 'arbeitnow',
    name: 'Arbeitnow Tech Jobs',
    type: 'public_api_arbeitnow',
    tier: 2,
    endpoint: 'https://www.arbeitnow.com/api/job-board-api',
    enabled: true,
    rate_limit_ms: 1000
  },
  {
    id: 'jobicy',
    name: 'Jobicy Remote API',
    type: 'public_api_jobicy',
    tier: 2,
    endpoint: 'https://jobicy.com/api/v2/remote-jobs',
    enabled: true,
    rate_limit_ms: 1000
  }
];

export function getSourceById(sourceId) {
  return DEFAULT_SOURCES.find(s => s.id === sourceId) || null;
}
