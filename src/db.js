import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SCHEMA_VERSION } from './schema.js';

let dbInstance = null;

export function getDb(dbPath = process.env.DB_PATH || './data/jobs.db') {
  if (dbInstance) return dbInstance;

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  if (dbPath !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
    } catch {
      // Some environments ignore WAL pragmas.
    }
  }

  initSchema(db);
  dbInstance = db;
  return db;
}

export function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore close errors in tests
    }
    dbInstance = null;
  }
}

export function setDb(customDb) {
  if (customDb) {
    initSchema(customDb);
  }
  dbInstance = customDb;
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map(column => column.name);
  if (!columns.includes(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
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
      supports_updated_at INTEGER DEFAULT 0,
      last_run_at TEXT,
      last_success_at TEXT,
      last_seen_at TEXT,
      last_status TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      circuit_open_until TEXT,
      circuit_trip_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      content_hash TEXT UNIQUE NOT NULL,
      source_record_key TEXT UNIQUE NOT NULL,
      last_seen_hash TEXT NOT NULL,
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
      salary_min_usd REAL,
      salary_max_usd REAL,
      salary_annual_usd REAL,
      description TEXT,
      tags_json TEXT,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_tier INTEGER NOT NULL,
      posted_at TEXT,
      ingested_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_confirmed_at TEXT NOT NULL,
      first_seen_run_id TEXT,
      last_seen_run_id TEXT,
      raw_fetch_id TEXT,
      missing_count INTEGER DEFAULT 0,
      completeness_score REAL DEFAULT 0,
      schema_version TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      is_stale INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_tier INTEGER NOT NULL,
      status TEXT NOT NULL,
      from_cache INTEGER DEFAULT 0,
      items_fetched INTEGER DEFAULT 0,
      items_parsed INTEGER DEFAULT 0,
      items_inserted INTEGER DEFAULT 0,
      items_deduped INTEGER DEFAULT 0,
      items_updated INTEGER DEFAULT 0,
      items_unchanged INTEGER DEFAULT 0,
      items_skipped INTEGER DEFAULT 0,
      items_stale INTEGER DEFAULT 0,
      review_queued INTEGER DEFAULT 0,
      error_message TEXT,
      drift_details_json TEXT,
      duration_ms INTEGER DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS raw_fetches (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      run_id TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      UNIQUE(source_id, run_id)
    );

    CREATE TABLE IF NOT EXISTS raw_cache (
      source_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      content_type TEXT DEFAULT 'application/json',
      etag TEXT,
      item_count INTEGER DEFAULT 0,
      run_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS failed_records (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_name TEXT,
      run_id TEXT,
      raw_fetch_id TEXT,
      raw_json TEXT,
      normalized_json TEXT,
      failure_reason TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      failed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dedup_review (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      candidate_job_id TEXT,
      existing_job_id TEXT,
      source_id TEXT,
      candidate_title TEXT,
      existing_title TEXT,
      candidate_company TEXT,
      existing_company TEXT,
      confidence REAL NOT NULL,
      decision_band TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_content_hash ON jobs(content_hash);
    CREATE INDEX IF NOT EXISTS idx_jobs_source_id ON jobs(source_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_source_tier ON jobs(source_tier);
    CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
    CREATE INDEX IF NOT EXISTS idx_jobs_posted_at ON jobs(posted_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_is_active ON jobs(is_active);
    CREATE INDEX IF NOT EXISTS idx_runs_source_id ON runs(source_id);
    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_raw_fetches_source_run ON raw_fetches(source_id, run_id);
    CREATE INDEX IF NOT EXISTS idx_failed_records_source ON failed_records(source_id);
    CREATE INDEX IF NOT EXISTS idx_dedup_review_source ON dedup_review(source_id);
  `);

  const jobColumns = [
    ['source_record_key', 'TEXT'],
    ['last_seen_hash', 'TEXT'],
    ['salary_min_usd', 'REAL'],
    ['salary_max_usd', 'REAL'],
    ['salary_annual_usd', 'REAL'],
    ['last_confirmed_at', 'TEXT'],
    ['first_seen_run_id', 'TEXT'],
    ['last_seen_run_id', 'TEXT'],
    ['raw_fetch_id', 'TEXT'],
    ['missing_count', 'INTEGER DEFAULT 0'],
    ['completeness_score', 'REAL DEFAULT 0'],
    ['schema_version', `TEXT DEFAULT '${SCHEMA_VERSION}'`],
    ['is_stale', 'INTEGER DEFAULT 0'],
    ['updated_at', 'TEXT']
  ];
  for (const [name, definition] of jobColumns) ensureColumn(db, 'jobs', name, definition);

  const sourceColumns = [
    ['supports_updated_at', 'INTEGER DEFAULT 0'],
    ['last_success_at', 'TEXT'],
    ['last_seen_at', 'TEXT'],
    ['consecutive_failures', 'INTEGER DEFAULT 0'],
    ['circuit_open_until', 'TEXT'],
    ['circuit_trip_count', 'INTEGER DEFAULT 0']
  ];
  for (const [name, definition] of sourceColumns) ensureColumn(db, 'sources', name, definition);

  const runColumns = [
    ['from_cache', 'INTEGER DEFAULT 0'],
    ['items_updated', 'INTEGER DEFAULT 0'],
    ['items_unchanged', 'INTEGER DEFAULT 0'],
    ['items_stale', 'INTEGER DEFAULT 0'],
    ['review_queued', 'INTEGER DEFAULT 0']
  ];
  for (const [name, definition] of runColumns) ensureColumn(db, 'runs', name, definition);

  ensureColumn(db, 'raw_cache', 'run_id', 'TEXT');

  backfillJobColumns(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_source_record_key ON jobs(source_record_key);

    DROP VIEW IF EXISTS jobs_by_company_daily;
    DROP VIEW IF EXISTS high_completeness_jobs;
    DROP VIEW IF EXISTS run_log;

    CREATE VIEW jobs_by_company_daily AS
      SELECT
        company,
        date(posted_at) AS posted_date,
        COUNT(*) AS job_count,
        ROUND(AVG(completeness_score), 3) AS avg_completeness
      FROM jobs
      WHERE is_active = 1 AND is_stale = 0
      GROUP BY company, date(posted_at);

    CREATE VIEW high_completeness_jobs AS
      SELECT *
      FROM jobs
      WHERE is_active = 1 AND is_stale = 0 AND completeness_score >= 0.75;

    CREATE VIEW run_log AS SELECT * FROM runs;
  `);
}

function backfillJobColumns(db) {
  const now = new Date().toISOString();
  const rows = db.prepare('SELECT * FROM jobs').all();
  const update = db.prepare(`
    UPDATE jobs
    SET
      source_record_key = coalesce(source_record_key, ?),
      last_seen_hash = coalesce(last_seen_hash, content_hash),
      last_confirmed_at = coalesce(last_confirmed_at, last_seen_at, ?),
      schema_version = coalesce(schema_version, ?),
      updated_at = coalesce(updated_at, ?)
    WHERE id = ?
  `);

  for (const row of rows) {
    const sourceRecordKey = row.source_record_key || makeSourceRecordKey(row);
    update.run(sourceRecordKey, now, SCHEMA_VERSION, now, row.id);
  }
}

function makeSourceRecordKey(job) {
  const stableValue = job.external_id || job.url || job.content_hash || crypto.randomUUID();
  const sourceId = job.source_id || 'unknown_source';
  return crypto.createHash('sha256').update(`${sourceId}|${stableValue}`).digest('hex');
}

function stringifyPayload(payload) {
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

function parsePayload(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function bool(value) {
  return value === true || value === 1;
}

function mapJobRow(row) {
  return {
    ...row,
    tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    is_remote: Boolean(row.is_remote),
    is_active: Boolean(row.is_active),
    is_stale: Boolean(row.is_stale)
  };
}

export function saveRawFetch({ source, runId, rawPayload, fetchedAt = new Date().toISOString() }) {
  const db = getDb();
  const id = `raw_${crypto.createHash('sha256').update(`${source.id}|${runId}`).digest('hex').slice(0, 24)}`;
  const rawJson = stringifyPayload(rawPayload);

  db.prepare(`
    INSERT OR IGNORE INTO raw_fetches (id, source_id, source_name, fetched_at, run_id, raw_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, source.id, source.name, fetchedAt, runId, rawJson);

  return getRawFetch(source.id, runId);
}

export function getRawFetch(sourceId, runId) {
  const row = getDb().prepare('SELECT * FROM raw_fetches WHERE source_id = ? AND run_id = ?').get(sourceId, runId);
  if (!row) return null;
  return {
    ...row,
    data: parsePayload(row.raw_json)
  };
}

function insertJob(db, job, now, runId, rawFetchId) {
  const stmt = db.prepare(`
    INSERT INTO jobs (
      id, content_hash, source_record_key, last_seen_hash, external_id,
      title, company, location, is_remote, job_type, category, url,
      salary_min, salary_max, salary_currency, salary_raw,
      salary_min_usd, salary_max_usd, salary_annual_usd,
      description, tags_json, source_id, source_name, source_tier,
      posted_at, ingested_at, last_seen_at, last_confirmed_at,
      first_seen_run_id, last_seen_run_id, raw_fetch_id, missing_count,
      completeness_score, schema_version, is_active, is_stale, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, 0,
      ?, ?, 1, 0, ?
    )
  `);

  stmt.run(
    job.id,
    job.content_hash,
    job.source_record_key,
    job.content_hash,
    job.external_id || null,
    job.title,
    job.company,
    job.location || 'Remote',
    bool(job.is_remote) ? 1 : 0,
    job.job_type || 'Full-time',
    job.category || 'General',
    job.url,
    job.salary_min ?? null,
    job.salary_max ?? null,
    job.salary_currency || null,
    job.salary_raw || null,
    job.salary_min_usd ?? null,
    job.salary_max_usd ?? null,
    job.salary_annual_usd ?? null,
    job.description || '',
    JSON.stringify(job.tags || []),
    job.source_id,
    job.source_name,
    job.source_tier,
    job.posted_at || now,
    job.ingested_at || now,
    now,
    now,
    runId || null,
    runId || null,
    rawFetchId || null,
    job.completeness_score ?? 0,
    job.schema_version || SCHEMA_VERSION,
    now
  );
}

function updateExistingJob(db, existing, job, now, runId, rawFetchId) {
  if (existing.last_seen_run_id === runId && existing.last_seen_hash === job.content_hash) {
    return 'unchanged';
  }

  if (existing.last_seen_hash === job.content_hash) {
    db.prepare(`
      UPDATE jobs
      SET last_seen_at = ?, last_confirmed_at = ?, last_seen_run_id = ?,
          raw_fetch_id = coalesce(?, raw_fetch_id), missing_count = 0,
          is_active = 1, is_stale = 0, updated_at = ?
      WHERE id = ?
    `).run(now, now, runId || null, rawFetchId || null, now, existing.id);
    return 'deduped';
  }

  db.prepare(`
    UPDATE jobs
    SET content_hash = ?, last_seen_hash = ?, external_id = ?, title = ?, company = ?,
        location = ?, is_remote = ?, job_type = ?, category = ?, url = ?,
        salary_min = ?, salary_max = ?, salary_currency = ?, salary_raw = ?,
        salary_min_usd = ?, salary_max_usd = ?, salary_annual_usd = ?,
        description = ?, tags_json = ?, source_name = ?, source_tier = ?,
        posted_at = ?, last_seen_at = ?, last_confirmed_at = ?, last_seen_run_id = ?,
        raw_fetch_id = coalesce(?, raw_fetch_id), missing_count = 0,
        completeness_score = ?, schema_version = ?, is_active = 1, is_stale = 0, updated_at = ?
    WHERE id = ?
  `).run(
    job.content_hash,
    job.content_hash,
    job.external_id || null,
    job.title,
    job.company,
    job.location || 'Remote',
    bool(job.is_remote) ? 1 : 0,
    job.job_type || 'Full-time',
    job.category || 'General',
    job.url,
    job.salary_min ?? null,
    job.salary_max ?? null,
    job.salary_currency || null,
    job.salary_raw || null,
    job.salary_min_usd ?? null,
    job.salary_max_usd ?? null,
    job.salary_annual_usd ?? null,
    job.description || '',
    JSON.stringify(job.tags || []),
    job.source_name,
    job.source_tier,
    job.posted_at || now,
    now,
    now,
    runId || null,
    rawFetchId || null,
    job.completeness_score ?? 0,
    job.schema_version || SCHEMA_VERSION,
    now,
    existing.id
  );
  return 'updated';
}

function normalizeWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function cityKey(location) {
  return String(location || 'remote').split(',')[0].trim().toLowerCase() || 'remote';
}

function jaccard(a, b) {
  const aSet = new Set(normalizeWords(a));
  const bSet = new Set(normalizeWords(b));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  const intersection = [...aSet].filter(value => bSet.has(value)).length;
  const union = new Set([...aSet, ...bSet]).size;
  return intersection / union;
}

function dateProximityScore(a, b) {
  if (!a || !b) return 0;
  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();
  if (Number.isNaN(aTime) || Number.isNaN(bTime)) return 0;
  const days = Math.abs(aTime - bTime) / 86400000;
  if (days <= 1) return 1;
  if (days >= 30) return 0;
  return 1 - (days / 30);
}

function findFuzzyDuplicate(db, job) {
  const candidates = db.prepare(`
    SELECT *
    FROM jobs
    WHERE lower(company) = lower(?)
      AND is_active = 1
      AND is_stale = 0
      AND content_hash <> ?
    LIMIT 25
  `).all(job.company, job.content_hash);

  let best = null;
  for (const candidate of candidates) {
    if (cityKey(candidate.location) !== cityKey(job.location)) continue;
    const titleScore = jaccard(candidate.title, job.title);
    const companyScore = candidate.company.toLowerCase() === job.company.toLowerCase() ? 1 : 0;
    const dateScore = dateProximityScore(candidate.posted_at, job.posted_at);
    const confidence = Number(((titleScore * 0.45) + (companyScore * 0.4) + (dateScore * 0.15)).toFixed(3));
    if (!best || confidence > best.confidence) {
      best = { row: candidate, confidence };
    }
  }
  return best;
}

function queueDedupReview(db, { runId, job, existing, confidence, decisionBand, reason }) {
  const now = new Date().toISOString();
  const id = `review_${crypto.createHash('sha256').update(`${runId}|${job.id}|${existing.id}`).digest('hex').slice(0, 24)}`;
  db.prepare(`
    INSERT OR IGNORE INTO dedup_review (
      id, run_id, candidate_job_id, existing_job_id, source_id,
      candidate_title, existing_title, candidate_company, existing_company,
      confidence, decision_band, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    runId || null,
    job.id,
    existing.id,
    job.source_id,
    job.title,
    existing.title,
    job.company,
    existing.company,
    confidence,
    decisionBand,
    reason,
    now
  );
}

export function upsertJobs(jobsList, { runId = null, rawFetchId = null, confirmedAt = new Date().toISOString() } = {}) {
  const db = getDb();
  let inserted = 0;
  let deduped = 0;
  let updated = 0;
  let unchanged = 0;
  let fuzzyMerged = 0;
  let reviewQueued = 0;

  const byHash = db.prepare('SELECT * FROM jobs WHERE content_hash = ?');
  const bySourceRecord = db.prepare('SELECT * FROM jobs WHERE source_record_key = ?');

  for (const originalJob of jobsList) {
    const job = {
      ...originalJob,
      source_record_key: originalJob.source_record_key || makeSourceRecordKey(originalJob),
      id: originalJob.id || `job_${crypto.randomUUID()}`,
      schema_version: originalJob.schema_version || SCHEMA_VERSION
    };

    const exact = byHash.get(job.content_hash);
    if (exact) {
      const result = updateExistingJob(db, exact, { ...job, content_hash: exact.content_hash }, confirmedAt, runId, rawFetchId);
      if (result === 'unchanged') unchanged++;
      else deduped++;
      continue;
    }

    const existingByKey = bySourceRecord.get(job.source_record_key);
    if (existingByKey) {
      const result = updateExistingJob(db, existingByKey, job, confirmedAt, runId, rawFetchId);
      if (result === 'unchanged') unchanged++;
      else if (result === 'updated') updated++;
      else deduped++;
      continue;
    }

    const fuzzy = findFuzzyDuplicate(db, job);
    if (fuzzy && fuzzy.confidence >= 0.9) {
      updateExistingJob(db, fuzzy.row, { ...job, content_hash: fuzzy.row.content_hash }, confirmedAt, runId, rawFetchId);
      fuzzyMerged++;
      continue;
    }

    if (fuzzy && fuzzy.confidence >= 0.7) {
      queueDedupReview(db, {
        runId,
        job,
        existing: fuzzy.row,
        confidence: fuzzy.confidence,
        decisionBand: 'review',
        reason: 'same company and city with similar title'
      });
      reviewQueued++;
    }

    insertJob(db, job, confirmedAt, runId, rawFetchId);
    inserted++;
  }

  return { inserted, deduped, updated, unchanged, fuzzyMerged, reviewQueued };
}

export function markMissingJobsStale(sourceId, seenSourceRecordKeys, {
  runId = null,
  staleAfterRuns = 3,
  checkedAt = new Date().toISOString()
} = {}) {
  const db = getDb();
  const seen = new Set(seenSourceRecordKeys);
  const rows = db.prepare(`
    SELECT id, source_record_key, missing_count, last_seen_run_id
    FROM jobs
    WHERE source_id = ? AND is_active = 1
  `).all(sourceId);

  let missingIncremented = 0;
  let staled = 0;

  const updateMissing = db.prepare(`
    UPDATE jobs
    SET missing_count = ?, is_stale = ?, is_active = ?, updated_at = ?
    WHERE id = ?
  `);

  for (const row of rows) {
    if (seen.has(row.source_record_key) || row.last_seen_run_id === runId) continue;

    const nextMissing = (row.missing_count || 0) + 1;
    const isStale = nextMissing >= staleAfterRuns ? 1 : 0;
    updateMissing.run(nextMissing, isStale, isStale ? 0 : 1, checkedAt, row.id);
    missingIncremented++;
    if (isStale) staled++;
  }

  return { missingIncremented, staled };
}

export function logRun(runData) {
  const db = getDb();
  const runId = runData.id || `run_${crypto.randomUUID()}`;
  const stmt = db.prepare(`
    INSERT INTO runs (
      id, source_id, source_name, source_tier, status, from_cache,
      items_fetched, items_parsed, items_inserted, items_deduped,
      items_updated, items_unchanged, items_skipped, items_stale, review_queued,
      error_message, drift_details_json, duration_ms, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      from_cache = excluded.from_cache,
      items_fetched = excluded.items_fetched,
      items_parsed = excluded.items_parsed,
      items_inserted = excluded.items_inserted,
      items_deduped = excluded.items_deduped,
      items_updated = excluded.items_updated,
      items_unchanged = excluded.items_unchanged,
      items_skipped = excluded.items_skipped,
      items_stale = excluded.items_stale,
      review_queued = excluded.review_queued,
      error_message = excluded.error_message,
      drift_details_json = excluded.drift_details_json,
      duration_ms = excluded.duration_ms,
      completed_at = excluded.completed_at
  `);

  stmt.run(
    runId,
    runData.source_id,
    runData.source_name,
    runData.source_tier,
    runData.status,
    runData.from_cache ? 1 : 0,
    runData.items_fetched || 0,
    runData.items_parsed || 0,
    runData.items_inserted || 0,
    runData.items_deduped || 0,
    runData.items_updated || 0,
    runData.items_unchanged || 0,
    runData.items_skipped || 0,
    runData.items_stale || 0,
    runData.review_queued || 0,
    runData.error_message || null,
    runData.drift_details ? JSON.stringify(runData.drift_details) : null,
    runData.duration_ms || 0,
    runData.started_at,
    runData.completed_at || new Date().toISOString()
  );

  db.prepare('UPDATE sources SET last_run_at = ?, last_status = ? WHERE id = ?')
    .run(runData.completed_at || new Date().toISOString(), runData.status, runData.source_id);

  return runId;
}

export function getRunById(runId) {
  const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!row) return null;
  return {
    ...row,
    from_cache: Boolean(row.from_cache),
    drift_details: row.drift_details_json ? JSON.parse(row.drift_details_json) : null
  };
}

export function saveFailedRecords(records, { source, runId, rawFetchId } = {}) {
  if (!records || records.length === 0) return 0;
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO failed_records (
      id, source_id, source_name, run_id, raw_fetch_id, raw_json,
      normalized_json, failure_reason, schema_version, failed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  for (const record of records) {
    const basis = `${runId}|${source?.id || record.source_id}|${record.failureReason}|${JSON.stringify(record.rawPayload || record.normalizedPayload || {})}`;
    const id = `failed_${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
    stmt.run(
      id,
      source?.id || record.source_id || 'unknown_source',
      source?.name || record.source_name || null,
      runId || record.run_id || null,
      rawFetchId || record.raw_fetch_id || null,
      record.rawPayload === undefined ? null : stringifyPayload(record.rawPayload),
      record.normalizedPayload === undefined ? null : stringifyPayload(record.normalizedPayload),
      record.failureReason || 'Contract validation failed',
      SCHEMA_VERSION,
      now
    );
    inserted++;
  }
  return inserted;
}

export function saveRawCache(sourceId, rawPayload, itemCount = 0, etag = null, runId = null) {
  const db = getDb();
  const now = new Date().toISOString();
  const payloadStr = stringifyPayload(rawPayload);

  db.prepare(`
    INSERT INTO raw_cache (source_id, payload, item_count, etag, run_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      payload = excluded.payload,
      item_count = excluded.item_count,
      etag = excluded.etag,
      run_id = excluded.run_id,
      updated_at = excluded.updated_at
  `).run(sourceId, payloadStr, itemCount, etag, runId, now);
}

export function getRawCache(sourceId) {
  const row = getDb().prepare('SELECT * FROM raw_cache WHERE source_id = ?').get(sourceId);
  if (!row) return null;
  return {
    source_id: row.source_id,
    data: parsePayload(row.payload),
    updated_at: row.updated_at,
    item_count: row.item_count,
    etag: row.etag,
    run_id: row.run_id
  };
}

export function queryJobs({
  search = '',
  company = '',
  tier = null,
  source = '',
  category = '',
  isRemote = null,
  minCompleteness = null,
  page = 1,
  limit = 20,
  sortBy = 'posted_at',
  sortOrder = 'DESC'
} = {}) {
  const db = getDb();
  const conditions = ['is_active = 1', 'is_stale = 0'];
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

  if (minCompleteness !== null && minCompleteness !== undefined && minCompleteness !== '') {
    conditions.push('completeness_score >= ?');
    params.push(Number(minCompleteness));
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const { total } = db.prepare(`SELECT COUNT(*) as total FROM jobs ${whereClause}`).get(...params);

  const offset = Math.max(0, (page - 1) * limit);
  const allowedSortCols = ['posted_at', 'ingested_at', 'title', 'company', 'salary_max', 'salary_annual_usd', 'completeness_score'];
  const sortCol = allowedSortCols.includes(sortBy) ? sortBy : 'posted_at';
  const order = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const rows = db.prepare(`
    SELECT * FROM jobs
    ${whereClause}
    ORDER BY ${sortCol} ${order}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / limit) || 1,
    jobs: rows.map(mapJobRow)
  };
}

export function getJobById(id) {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return row ? mapJobRow(row) : null;
}

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

  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    from_cache: Boolean(row.from_cache),
    drift_details: row.drift_details_json ? JSON.parse(row.drift_details_json) : null
  }));
}

export function getDedupReviewQueue({ limit = 50 } = {}) {
  return getDb().prepare('SELECT * FROM dedup_review ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function getFailedRecords({ limit = 50 } = {}) {
  return getDb().prepare('SELECT * FROM failed_records ORDER BY failed_at DESC LIMIT ?').all(limit);
}

export function getGoldSummaries() {
  const db = getDb();
  return {
    jobsByCompanyDaily: db.prepare('SELECT * FROM jobs_by_company_daily ORDER BY posted_date DESC, job_count DESC LIMIT 50').all(),
    highCompletenessCount: db.prepare('SELECT COUNT(*) AS total FROM high_completeness_jobs').get().total
  };
}

function averageDailyCount(db, sourceId) {
  const rows = db.prepare(`
    SELECT date(ingested_at) AS day, COUNT(*) AS count
    FROM jobs
    WHERE source_id = ? AND ingested_at >= datetime('now', '-7 days')
    GROUP BY date(ingested_at)
  `).all(sourceId);
  if (rows.length === 0) return 0;
  return Number((rows.reduce((sum, row) => sum + row.count, 0) / rows.length).toFixed(2));
}

function sourceDistribution(db, sourceId) {
  const total = db.prepare('SELECT COUNT(*) AS total FROM jobs WHERE source_id = ? AND is_active = 1').get(sourceId).total || 0;
  if (total === 0) {
    return { nullSalaryPercent: 0, topCompanySharePercent: 0, topCompany: null };
  }

  const nullSalary = db.prepare(`
    SELECT COUNT(*) AS total
    FROM jobs
    WHERE source_id = ? AND is_active = 1
      AND salary_min IS NULL AND salary_max IS NULL AND salary_raw IS NULL
  `).get(sourceId).total || 0;

  const topCompany = db.prepare(`
    SELECT company, COUNT(*) AS count
    FROM jobs
    WHERE source_id = ? AND is_active = 1
    GROUP BY company
    ORDER BY count DESC
    LIMIT 1
  `).get(sourceId);

  return {
    nullSalaryPercent: Number(((nullSalary / total) * 100).toFixed(1)),
    topCompanySharePercent: topCompany ? Number(((topCompany.count / total) * 100).toFixed(1)) : 0,
    topCompany: topCompany?.company || null
  };
}

export function getSourceObservability() {
  const db = getDb();
  const sources = getSources();
  const today = new Date().toISOString().slice(0, 10);

  return sources.map(source => {
    const todayCount = db.prepare(`
      SELECT COUNT(*) AS total FROM jobs
      WHERE source_id = ? AND date(ingested_at) = ?
    `).get(source.id, today).total || 0;

    const schemaFailuresToday = db.prepare(`
      SELECT COUNT(*) AS total FROM failed_records
      WHERE source_id = ? AND date(failed_at) = ?
    `).get(source.id, today).total || 0;

    const lastSuccess = source.last_success_at || null;
    const freshnessSeconds = lastSuccess
      ? Math.max(0, Math.floor((Date.now() - new Date(lastSuccess).getTime()) / 1000))
      : null;

    return {
      source_id: source.id,
      source_name: source.name,
      freshness: {
        last_success_at: lastSuccess,
        seconds_since_success: freshnessSeconds
      },
      volume: {
        today_count: todayCount,
        rolling_7_day_daily_avg: averageDailyCount(db, source.id)
      },
      schema: {
        failures_today: schemaFailuresToday,
        drift_events_total: db.prepare("SELECT COUNT(*) AS total FROM runs WHERE source_id = ? AND status = 'drift_error'").get(source.id).total || 0
      },
      distribution: sourceDistribution(db, source.id)
    };
  });
}

export function getPipelineMetrics() {
  const db = getDb();

  const totalJobsRow = db.prepare('SELECT COUNT(*) as total FROM jobs WHERE is_active = 1 AND is_stale = 0').get();
  const totalRunsRow = db.prepare('SELECT COUNT(*) as total FROM runs').get();
  const dedupStatsRow = db.prepare(`
    SELECT
      SUM(items_fetched) as total_fetched,
      SUM(items_inserted) as total_inserted,
      SUM(items_deduped) as total_deduped,
      SUM(items_updated) as total_updated,
      SUM(items_unchanged) as total_unchanged,
      SUM(items_skipped) as total_skipped,
      SUM(items_stale) as total_stale,
      SUM(review_queued) as total_review_queued
    FROM runs
  `).get();

  const tierDistribution = db.prepare(`
    SELECT source_tier, COUNT(*) as count
    FROM jobs
    WHERE is_active = 1 AND is_stale = 0
    GROUP BY source_tier
    ORDER BY source_tier ASC
  `).all();

  const statusDistribution = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM runs
    GROUP BY status
  `).all();

  const recentRuns = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 5').all();
  const totalFetched = dedupStatsRow.total_fetched || 0;
  const totalDeduped = (dedupStatsRow.total_deduped || 0) + (dedupStatsRow.total_unchanged || 0);
  const dedupRate = totalFetched > 0 ? ((totalDeduped / totalFetched) * 100).toFixed(1) : '0.0';

  return {
    schemaVersion: SCHEMA_VERSION,
    totalJobs: totalJobsRow.total || 0,
    totalRuns: totalRunsRow.total || 0,
    totalFetched,
    totalInserted: dedupStatsRow.total_inserted || 0,
    totalDeduped,
    totalUpdated: dedupStatsRow.total_updated || 0,
    totalUnchanged: dedupStatsRow.total_unchanged || 0,
    totalSkipped: dedupStatsRow.total_skipped || 0,
    totalStale: dedupStatsRow.total_stale || 0,
    totalReviewQueued: dedupStatsRow.total_review_queued || 0,
    deduplicationRatePercent: Number(dedupRate),
    tierDistribution: tierDistribution.reduce((acc, row) => {
      acc[`tier_${row.source_tier}`] = row.count;
      return acc;
    }, {}),
    statusDistribution: statusDistribution.reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {}),
    recentRuns: recentRuns.map(row => ({
      ...row,
      from_cache: Boolean(row.from_cache),
      drift_details: row.drift_details_json ? JSON.parse(row.drift_details_json) : null
    })),
    sourceObservability: getSourceObservability(),
    gold: getGoldSummaries()
  };
}

export function seedSources(sourcesList) {
  const db = getDb();
  if (sourcesList.length > 0) {
    const idList = sourcesList.map(source => `'${source.id.replace(/'/g, "''")}'`).join(',');
    db.exec(`DELETE FROM sources WHERE id NOT IN (${idList})`);
  }

  const insertStmt = db.prepare(`
    INSERT INTO sources (
      id, name, type, tier, endpoint, enabled, rate_limit_ms,
      supports_updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      tier = excluded.tier,
      endpoint = excluded.endpoint,
      enabled = excluded.enabled,
      rate_limit_ms = excluded.rate_limit_ms,
      supports_updated_at = excluded.supports_updated_at
  `);

  const now = new Date().toISOString();
  for (const source of sourcesList) {
    insertStmt.run(
      source.id,
      source.name,
      source.type,
      source.tier,
      source.endpoint,
      source.enabled ? 1 : 0,
      source.rate_limit_ms || 1000,
      source.supports_updated_at ? 1 : 0,
      now
    );
  }
}

export function getSources() {
  return getDb().prepare('SELECT * FROM sources ORDER BY tier ASC, name ASC').all().map(row => ({
    ...row,
    enabled: Boolean(row.enabled),
    supports_updated_at: Boolean(row.supports_updated_at)
  }));
}

export function getSourceRuntimeState(sourceId) {
  return getDb().prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) || null;
}

export function isCircuitOpen(sourceId, now = new Date()) {
  const source = getSourceRuntimeState(sourceId);
  if (!source?.circuit_open_until) {
    return { open: false, source };
  }
  const openUntil = new Date(source.circuit_open_until);
  return {
    open: openUntil.getTime() > now.getTime(),
    openUntil: source.circuit_open_until,
    source
  };
}

export function recordSourceSuccess(sourceId, { completedAt = new Date().toISOString(), lastSeenAt = completedAt } = {}) {
  getDb().prepare(`
    UPDATE sources
    SET last_run_at = ?, last_success_at = ?, last_seen_at = ?,
        last_status = 'success', consecutive_failures = 0, circuit_open_until = NULL
    WHERE id = ?
  `).run(completedAt, completedAt, lastSeenAt, sourceId);
}

export function recordSourceFailure(sourceId, {
  status,
  completedAt = new Date().toISOString(),
  circuitThreshold = 3,
  cooldownBaseMs = 60000
} = {}) {
  const db = getDb();
  const source = getSourceRuntimeState(sourceId);
  if (!source) return null;

  const consecutiveFailures = (source.consecutive_failures || 0) + 1;
  let tripCount = source.circuit_trip_count || 0;
  let openUntil = source.circuit_open_until || null;

  if (consecutiveFailures >= circuitThreshold) {
    tripCount += 1;
    const cooldownMs = cooldownBaseMs * Math.pow(2, Math.max(0, tripCount - 1));
    openUntil = new Date(new Date(completedAt).getTime() + cooldownMs).toISOString();
  }

  db.prepare(`
    UPDATE sources
    SET last_run_at = ?, last_status = ?, consecutive_failures = ?,
        circuit_open_until = ?, circuit_trip_count = ?
    WHERE id = ?
  `).run(completedAt, status || 'fetch_error', consecutiveFailures, openUntil, tripCount, sourceId);

  return { consecutiveFailures, circuitOpenUntil: openUntil, circuitTripCount: tripCount };
}
