import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SOURCES } from '../src/sources.js';

const DISALLOWED_DOMAINS = [
  'linkedin.com',
  'naukri.com',
  'wellfound.com'
];

const ALLOWED_DOMAINS = [
  'boards-api.greenhouse.io',
  'api.lever.co',
  'api.ashbyhq.com',
  'remoteok.com',
  'www.arbeitnow.com',
  'jobicy.com'
];

function hostnameFor(endpoint) {
  return new URL(endpoint).hostname;
}

test('Source compliance - live sources only target explicit Tier 1/2 allowlist', () => {
  for (const source of DEFAULT_SOURCES) {
    const hostname = hostnameFor(source.endpoint);
    assert.ok(
      ALLOWED_DOMAINS.includes(hostname),
      `${source.id} targets non-allowlisted domain ${hostname}`
    );

    for (const domain of DISALLOWED_DOMAINS) {
      assert.ok(
        !hostname.endsWith(domain),
        `${source.id} must not target disallowed domain ${domain}`
      );
    }

    assert.notEqual(source.tier, 3, `${source.id} must not be a live Tier 3 source`);
  }
});
