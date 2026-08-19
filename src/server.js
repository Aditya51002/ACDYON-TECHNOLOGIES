import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { 
  getDb, 
  queryJobs, 
  getJobById, 
  queryRuns, 
  getPipelineMetrics, 
  getSources 
} from './db.js';
import { 
  runSource, 
  runAllSources, 
  initializeSources, 
  isPipelineRunning 
} from './pipeline.js';
import { 
  startScheduler, 
  getSchedulerStatus 
} from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
const PORT = process.env.PORT || 3000;
const startTime = Date.now();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Initialize DB and Sources
getDb();
initializeSources();

if (process.env.ENABLE_AUTO_SYNC === 'true') {
  startScheduler();
}

/**
 * Health check endpoint (/health and /api/health)
 */
const handleHealth = (req, res) => {
  const dbPath = process.env.DB_PATH || './data/jobs.db';
  let dbSizeBytes = 0;
  if (fs.existsSync(dbPath)) {
    try {
      dbSizeBytes = fs.statSync(dbPath).size;
    } catch {
      // ignore
    }
  }

  const metrics = getPipelineMetrics();
  const scheduler = getSchedulerStatus();
  const recentRuns = queryRuns({ limit: 1 });
  const lastRun = recentRuns[0] || null;

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    pipeline: {
      is_running: isPipelineRunning(),
      total_active_jobs: metrics.totalJobs,
      total_runs_completed: metrics.totalRuns,
      deduplication_rate_percent: metrics.deduplicationRatePercent,
      last_run: lastRun ? {
        source_name: lastRun.source_name,
        status: lastRun.status,
        completed_at: lastRun.completed_at,
        duration_ms: lastRun.duration_ms
      } : null,
      scheduler: scheduler.isActive ? {
        active: true,
        interval_minutes: scheduler.intervalMinutes,
        next_run: scheduler.nextScheduledRun
      } : { active: false }
    },
    database: {
      type: 'sqlite3',
      file_size_bytes: dbSizeBytes,
      file_size_kb: (dbSizeBytes / 1024).toFixed(1)
    }
  });
};

app.get('/health', handleHealth);
app.get('/api/health', handleHealth);

/**
 * Get Job Listings with filtering, search, pagination, and sorting
 * (/jobs and /api/jobs)
 */
const handleJobs = (req, res) => {
  try {
    const { 
      search, 
      company, 
      tier, 
      source, 
      category, 
      isRemote, 
      page = 1, 
      limit = 20, 
      sortBy = 'posted_at', 
      sortOrder = 'DESC' 
    } = req.query;

    const result = queryJobs({
      search,
      company,
      tier,
      source,
      category,
      isRemote,
      page: Number(page),
      limit: Math.min(100, Number(limit)),
      sortBy,
      sortOrder
    });

    res.json({
      success: true,
      data: result.jobs,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages
      },
      filtersApplied: {
        search: search || null,
        company: company || null,
        tier: tier || null,
        source: source || null,
        category: category || null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

app.get('/jobs', handleJobs);
app.get('/api/jobs', handleJobs);

/**
 * Get single job by ID
 */
const handleJobDetail = (req, res) => {
  try {
    const job = getJobById(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    res.json({ success: true, data: job });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

app.get('/jobs/:id', handleJobDetail);
app.get('/api/jobs/:id', handleJobDetail);

/**
 * Get Ingestion Run History (/runs and /api/runs)
 */
const handleRuns = (req, res) => {
  try {
    const { limit = 50, offset = 0, sourceId } = req.query;
    const runs = queryRuns({
      limit: Math.min(200, Number(limit)),
      offset: Number(offset),
      sourceId
    });
    res.json({ success: true, count: runs.length, data: runs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

app.get('/runs', handleRuns);
app.get('/api/runs', handleRuns);

/**
 * Get configured sources
 */
app.get('/api/sources', (req, res) => {
  try {
    const sources = getSources();
    res.json({ success: true, count: sources.length, data: sources });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Get pipeline summary metrics
 */
app.get('/api/metrics', (req, res) => {
  try {
    const metrics = getPipelineMetrics();
    res.json({ success: true, data: metrics });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Trigger manual ingestion run or simulation
 */
app.post('/api/pipeline/trigger', async (req, res) => {
  try {
    const { sourceId, simulateFailure, simulateDrift } = req.body || {};

    if (sourceId) {
      const result = await runSource(sourceId, {
        simulateFailure: Boolean(simulateFailure),
        simulateDrift: Boolean(simulateDrift)
      });
      return res.json({ success: true, run: result });
    }

    // Trigger all sources
    const result = await runAllSources({
      simulateFailure: Boolean(simulateFailure),
      simulateDrift: Boolean(simulateDrift)
    });
    res.json({ success: true, ...result });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Start or stop the periodic scheduler
 */
app.post('/api/scheduler/toggle', (req, res) => {
  const { active, intervalMinutes } = req.body || {};
  if (active) {
    startScheduler(intervalMinutes);
  } else {
    startScheduler(); // fallback
  }
  res.json({ success: true, status: getSchedulerStatus() });
});

// Fallback index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Server boot helper for programmatic start / export
export function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`[Server] Job Ingestion API & Dashboard live on http://localhost:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// Auto-start only when executed directly as CLI script
const isDirectRun = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  process.argv[1].endsWith('server.js')
);

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  startServer(PORT);
}

export default app;
