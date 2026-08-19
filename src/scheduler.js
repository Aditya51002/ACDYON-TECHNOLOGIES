import { runAllSources, isPipelineRunning } from './pipeline.js';

let timerId = null;
let lastScheduledRun = null;
let nextScheduledRun = null;
let intervalMinutes = Number(process.env.SYNC_INTERVAL_MINUTES) || 15;

/**
 * Start scheduler for periodic ingestion
 * @param {number} [customIntervalMinutes]
 */
export function startScheduler(customIntervalMinutes) {
  if (customIntervalMinutes) {
    intervalMinutes = customIntervalMinutes;
  }

  if (timerId) {
    clearInterval(timerId);
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  nextScheduledRun = new Date(Date.now() + intervalMs).toISOString();

  timerId = setInterval(async () => {
    if (!isPipelineRunning()) {
      lastScheduledRun = new Date().toISOString();
      try {
        await runAllSources();
      } catch (err) {
        console.error('[Scheduler] Ingestion error:', err.message);
      }
      nextScheduledRun = new Date(Date.now() + intervalMs).toISOString();
    }
  }, intervalMs);

  console.log(`[Scheduler] Ingestion scheduler started: every ${intervalMinutes} min. Next run: ${nextScheduledRun}`);
}

/**
 * Stop scheduler
 */
export function stopScheduler() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
    nextScheduledRun = null;
    console.log('[Scheduler] Ingestion scheduler stopped');
  }
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus() {
  return {
    isActive: Boolean(timerId),
    intervalMinutes,
    lastScheduledRun,
    nextScheduledRun,
    isPipelineRunning: isPipelineRunning()
  };
}
