import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let dbInstance = null;

/**
 * Initialize or get SQLite database connection.
 * @param {string} [dbPath] Custom path to DB file, or in-memory if ':memory:'
 * @returns {DatabaseSync}
 */
export function getDb(dbPath = process.env.DB_PATH || './data/jobs.db') {
  if (dbInstance) return dbInstance;

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  // Enable WAL mode for high concurrency if file-based
  if (dbPath !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
    } catch {
      // Memory or restricted environments might ignore
    }
  }

  initSchema(db);
  dbInstance = db;
  return db;
}

/**
 * Reset database instance (useful for clean unit tests)
 */
export function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
    dbInstance = null;
  }
}

/**
 * Set custom database instance (e.g. for testing in-memory DB)
 */
export function setDb(customDb) {
  if (customDb) {
    initSchema(customDb);
  }
  dbInstance = customDb;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      tier INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      rate_limit_ms INTEGER DEFAULT 1000,
      last_run_at TEXT,
      last_status TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      content_hash TEXT UNIQUE NOT NULL,
      external_id TEXT,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT,
      is_remote INTEGER DEFAULT 0,
      job_type TEXT,
      category TEXT,
      url TEXT NOT NULL,
      salary_min REAL,
      salary_max REAL,
      salary_currency TEXT,
      salary_raw TEXT,
      description TEXT,
      tags_json TEXT,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_tier INTEGER NOT NULL,
      posted_at TEXT,
      ingested_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_tier INTEGER NOT NULL,
      status TEXT NOT NULL,
      items_fetched INTEGER DEFAULT 0,
      items_parsed INTEGER DEFAULT 0,
      items_inserted INTEGER DEFAULT 0,
      items_deduped INTEGER DEFAULT 0,
      items_skipped INTEGER DEFAULT 0,
      error_message TEXT,
      drift_details_json TEXT,
      duration_ms INTEGER DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS raw_cache (
      source_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      content_type TEXT DEFAULT 'application/json',
      etag TEXT,
      item_count INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_content_hash ON jobs(content_hash);
    CREATE INDEX IF NOT EXISTS idx_jobs_source_id ON jobs(source_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_source_tier ON jobs(source_tier);
    CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
    CREATE INDEX IF NOT EXISTS idx_jobs_posted_at ON jobs(posted_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_is_active ON jobs(is_active);
    CREATE INDEX IF NOT EXISTS idx_runs_source_id ON runs(source_id);
    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
  `);
}

/**
 * Upsert or refresh a batch of canonical job items.
 * Performs content-hash based deduplication:
 * - If content_hash is new: inserts job.
 * - If content_hash exists: updates last_seen_at and ensures is_active = 1 without creating duplicate row.
 * @param {Array<Object>} jobsList
 * @returns {{ inserted: number, deduped: number }}
 */
export function upsertJobs(jobsList) {
  const db = getDb();
  let inserted = 0;
  let deduped = 0;
  const now = new Date().toISOString();

  const checkStmt = db.prepare('SELECT id FROM jobs WHERE content_hash = ?');
  const updateStmt = db.prepare(`
    UPDATE jobs 
    SET last_seen_at = ?, is_active = 1, url = coalesce(?, url), salary_raw = coalesce(?, salary_raw)
    WHERE content_hash = ?
  `);
  const insertStmt = db.prepare(`
    INSERT INTO jobs (
      id, content_hash, external_id, title, company, location, is_remote,
      job_type, category, url, salary_min, salary_max, salary_currency,
      salary_raw, description, tags_json, source_id, source_name,
      source_tier, posted_at, ingested_at, last_seen_at, is_active
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, 1
    )
  `);

  for (const job of jobsList) {
    const existing = checkStmt.get(job.content_hash);
    if (existing) {
      updateStmt.run(now, job.url || null, job.salary_raw || null, job.content_hash);
      deduped++;
    } else {
      const jobId = job.id || `job_${crypto.randomUUID()}`;
      insertStmt.run(
        jobId,
        job.content_hash,
        job.external_id || null,
        job.title,
        job.company,
        job.location || 'Remote',
        job.is_remote ? 1 : 0,
        job.job_type || 'Full-time',
        job.category || 'General',
        job.url,
        job.salary_min !== undefined ? job.salary_min : null,
        job.salary_max !== undefined ? job.salary_max : null,
        job.salary_currency || null,
        job.salary_raw || null,
        job.description || '',
        JSON.stringify(job.tags || []),
        job.source_id,
        job.source_name,
        job.source_tier,
        job.posted_at || now,
        job.ingested_at || now,
        now
      );
      inserted++;
    }
  }

  return { inserted, deduped };
}

/**
 * Log an ingestion run
 */
export function logRun(runData) {
  const db = getDb();
  const runId = runData.id || `run_${crypto.randomUUID()}`;
  const stmt = db.prepare(`
    INSERT INTO runs (
      id, source_id, source_name, source_tier, status,
      items_fetched, items_parsed, items_inserted, items_deduped, items_skipped,
      error_message, drift_details_json, duration_ms, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    runId,
    runData.source_id,
    runData.source_name,
    runData.source_tier,
    runData.status,
    runData.items_fetched || 0,
    runData.items_parsed || 0,
    runData.items_inserted || 0,
    runData.items_deduped || 0,
    runData.items_skipped || 0,
    runData.error_message || null,
    runData.drift_details ? JSON.stringify(runData.drift_details) : null,
    runData.duration_ms || 0,
    runData.started_at,
    runData.completed_at || new Date().toISOString()
  );

  // Update source last status
  const updateSourceStmt = db.prepare(`
    UPDATE sources SET last_run_at = ?, last_status = ? WHERE id = ?
  `);
  updateSourceStmt.run(runData.completed_at || new Date().toISOString(), runData.status, runData.source_id);

  return runId;
}

/**
 * Save raw cache snapshot for a source (for last-known-good fallback)
 */
export function saveRawCache(sourceId, rawPayload, itemCount = 0, etag = null) {
  const db = getDb();
  const now = new Date().toISOString();
  const payloadStr = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);

  const stmt = db.prepare(`
    INSERT INTO raw_cache (source_id, payload, item_count, etag, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      payload = excluded.payload,
      item_count = excluded.item_count,
      etag = excluded.etag,
      updated_at = excluded.updated_at
  `);

  stmt.run(sourceId, payloadStr, itemCount, etag, now);
}

/**
 * Retrieve last-known-good raw cache for a source
 */
export function getRawCache(sourceId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM raw_cache WHERE source_id = ?');
  const row = stmt.get(sourceId);
  if (!row) return null;
  try {
    return {
      source_id: row.source_id,
      data: JSON.parse(row.payload),
      updated_at: row.updated_at,
      item_count: row.item_count,
      etag: row.etag
    };
  } catch {
    return {
      source_id: row.source_id,
      data: row.payload,
      updated_at: row.updated_at,
      item_count: row.item_count,
      etag: row.etag
    };
  }
}

/**
 * Query jobs with search, filters, pagination, and sorting
 */
export function queryJobs({
  search = '',
  company = '',
  tier = null,
  source = '',
  category = '',
  isRemote = null,
  page = 1,
  limit = 20,
  sortBy = 'posted_at',
  sortOrder = 'DESC'
} = {}) {
  const db = getDb();
  const conditions = ['is_active = 1'];
  const params = [];

  if (search && search.trim()) {
    conditions.push('(title LIKE ? OR company LIKE ? OR description LIKE ? OR tags_json LIKE ?)');
    const term = `%${search.trim()}%`;
    params.push(term, term, term, term);
  }

  if (company && company.trim()) {
    conditions.push('company LIKE ?');
    params.push(`%${company.trim()}%`);
  }

  if (tier !== null && tier !== undefined && tier !== '') {
    conditions.push('source_tier = ?');
    params.push(Number(tier));
  }

  if (source && source.trim()) {
    conditions.push('source_id = ?');
    params.push(source.trim());
  }

  if (category && category.trim()) {
    conditions.push('category = ?');
    params.push(category.trim());
  }

  if (isRemote !== null && isRemote !== undefined && isRemote !== '') {
    conditions.push('is_remote = ?');
    params.push(isRemote === 'true' || isRemote === 1 || isRemote === true ? 1 : 0);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM jobs ${whereClause}`);
  const { total } = countStmt.get(...params);

  // Pagination & sorting
  const offset = Math.max(0, (page - 1) * limit);
  const allowedSortCols = ['posted_at', 'ingested_at', 'title', 'company', 'salary_max'];
  const sortCol = allowedSortCols.includes(sortBy) ? sortBy : 'posted_at';
  const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const dataStmt = db.prepare(`
    SELECT * FROM jobs
    ${whereClause}
    ORDER BY ${sortCol} ${order}
    LIMIT ? OFFSET ?
  `);

  const rows = dataStmt.all(...params, limit, offset);

  // Parse JSON tags
  const jobs = rows.map(row => ({
    ...row,
    tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    is_remote: Boolean(row.is_remote),
    is_active: Boolean(row.is_active)
  }));

  return {
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / limit) || 1,
    jobs
  };
}

/**
 * Get single job by ID
 */
export function getJobById(id) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const row = stmt.get(id);
  if (!row) return null;
  return {
    ...row,
    tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    is_remote: Boolean(row.is_remote),
    is_active: Boolean(row.is_active)
  };
}

/**
 * Get runs history
 */
export function queryRuns({ limit = 30, offset = 0, sourceId = null } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM runs';
  const params = [];

  if (sourceId) {
    sql += ' WHERE source_id = ?';
    params.push(sourceId);
  }

  sql += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params);

  return rows.map(row => ({
    ...row,
    drift_details: row.drift_details_json ? JSON.parse(row.drift_details_json) : null
  }));
}

/**
 * Get summary pipeline metrics
 */
export function getPipelineMetrics() {
  const db = getDb();

  const totalJobsRow = db.prepare('SELECT COUNT(*) as total FROM jobs WHERE is_active = 1').get();
  const totalRunsRow = db.prepare('SELECT COUNT(*) as total FROM runs').get();
  const dedupStatsRow = db.prepare(`
    SELECT 
      SUM(items_fetched) as total_fetched,
      SUM(items_inserted) as total_inserted,
      SUM(items_deduped) as total_deduped,
      SUM(items_skipped) as total_skipped
    FROM runs
  `).get();

  const tierDistribution = db.prepare(`
    SELECT source_tier, COUNT(*) as count 
    FROM jobs 
    WHERE is_active = 1 
    GROUP BY source_tier 
    ORDER BY source_tier ASC
  `).all();

  const statusDistribution = db.prepare(`
    SELECT status, COUNT(*) as count 
    FROM runs 
    GROUP BY status
  `).all();

  const recentRuns = db.prepare(`
    SELECT * FROM runs ORDER BY started_at DESC LIMIT 5
  `).all();

  const totalFetched = dedupStatsRow.total_fetched || 0;
  const totalDeduped = dedupStatsRow.total_deduped || 0;
  const dedupRate = totalFetched > 0 ? ((totalDeduped / totalFetched) * 100).toFixed(1) : '0.0';

  return {
    totalJobs: totalJobsRow.total || 0,
    totalRuns: totalRunsRow.total || 0,
    totalFetched,
    totalInserted: dedupStatsRow.total_inserted || 0,
    totalDeduped,
    totalSkipped: dedupStatsRow.total_skipped || 0,
    deduplicationRatePercent: Number(dedupRate),
    tierDistribution: tierDistribution.reduce((acc, row) => {
      acc[`tier_${row.source_tier}`] = row.count;
      return acc;
    }, {}),
    statusDistribution: statusDistribution.reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {}),
    recentRuns: recentRuns.map(r => ({
      ...r,
      drift_details: r.drift_details_json ? JSON.parse(r.drift_details_json) : null
    }))
  };
}

/**
 * Register default sources into DB if not present
 */
export function seedSources(sourcesList) {
  const db = getDb();
  if (sourcesList.length > 0) {
    const idList = sourcesList.map(s => `'${s.id}'`).join(',');
    db.exec(`DELETE FROM sources WHERE id NOT IN (${idList})`);
  }

  const insertStmt = db.prepare(`
    INSERT INTO sources (id, name, type, tier, endpoint, enabled, rate_limit_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      tier = excluded.tier,
      endpoint = excluded.endpoint,
      rate_limit_ms = excluded.rate_limit_ms
  `);

  const now = new Date().toISOString();
  for (const s of sourcesList) {
    insertStmt.run(
      s.id,
      s.name,
      s.type,
      s.tier,
      s.endpoint,
      s.enabled ? 1 : 0,
      s.rate_limit_ms || 1000,
      now
    );
  }
}

/**
 * Get all registered sources
 */
export function getSources() {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM sources ORDER BY tier ASC, name ASC');
  const rows = stmt.all();
  return rows.map(r => ({
    ...r,
    enabled: Boolean(r.enabled)
  }));
}
