#!/usr/bin/env node
import { initializeSources, runAllSources, runSource } from './pipeline.js';
import { getPipelineMetrics } from './db.js';

async function main() {
  const args = process.argv.slice(2);
  const sourceId = args[0];

  console.log('=== Job Listings Ingestion Pipeline CLI ===');
  initializeSources();

  if (sourceId && sourceId !== '--all') {
    console.log(`Running ingestion for source: ${sourceId}`);
    const result = await runSource(sourceId);
    console.log('Result:', JSON.stringify(result, null, 2));
  } else {
    console.log('Running ingestion across all enabled sources...');
    const result = await runAllSources();
    console.log('Summary:', JSON.stringify(result, null, 2));
  }

  const metrics = getPipelineMetrics();
  console.log('\n--- Pipeline Metrics ---');
  console.log(`Total Active Jobs: ${metrics.totalJobs}`);
  console.log(`Total Deduplicated: ${metrics.totalDeduped} (${metrics.deduplicationRatePercent}%)`);
  console.log(`Total Runs: ${metrics.totalRuns}`);
}

main().catch(err => {
  console.error('CLI Fatal Error:', err);
  process.exit(1);
});
