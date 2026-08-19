import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SOURCES } from '../src/sources.js';

const repoRoot = path.resolve('.');
const docs = fs.readFileSync(path.join(repoRoot, 'DECISIONS.md'), 'utf8');
const srcFiles = fs.readdirSync(path.join(repoRoot, 'src'))
  .filter(file => file.endsWith('.js'))
  .map(file => fs.readFileSync(path.join(repoRoot, 'src', file), 'utf8').toLowerCase())
  .join('\n');

test('Docs-code consistency - Tier 3 sources are documented as design-only and absent from code', () => {
  assert.match(docs, /Tier 3 Hostile Sources - Design Only/i);
  assert.match(docs, /no source entry, no parser, no cache seed/i);

  const disallowedCodeTokens = [
    'linkedin.com',
    'naukri.com',
    'wellfound.com',
    'aggregator_linkedin',
    'aggregator_naukri',
    'aggregator_wellfound'
  ];

  for (const token of disallowedCodeTokens) {
    assert.ok(!srcFiles.includes(token), `src must not contain live Tier 3 token: ${token}`);
  }
});

test('Docs-code consistency - every live source is described as Tier 1 or Tier 2', () => {
  for (const source of DEFAULT_SOURCES) {
    assert.ok(source.tier === 1 || source.tier === 2, `${source.id} must be Tier 1/2`);
  }

  assert.match(docs, /Greenhouse/i);
  assert.match(docs, /RemoteOK/i);
  assert.match(docs, /Arbeitnow/i);
  assert.match(docs, /Jobicy/i);
});
