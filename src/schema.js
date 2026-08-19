import { z } from 'zod';

export const SCHEMA_VERSION = '2.0.0';

export const CANONICAL_FIELDS = [
  'id',
  'content_hash',
  'source_record_key',
  'external_id',
  'title',
  'company',
  'location',
  'is_remote',
  'job_type',
  'category',
  'url',
  'salary_min',
  'salary_max',
  'salary_currency',
  'salary_raw',
  'salary_min_usd',
  'salary_max_usd',
  'salary_annual_usd',
  'description',
  'tags',
  'source_id',
  'source_name',
  'source_tier',
  'posted_at',
  'ingested_at',
  'run_id',
  'completeness_score',
  'schema_version'
];

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().finite().nullable().optional();

export const canonicalJobSchema = z.object({
  id: z.string().min(1),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  source_record_key: z.string().min(1),
  external_id: nullableString,
  title: z.string().trim().min(2),
  company: z.string().trim().min(1),
  location: nullableString,
  is_remote: z.boolean(),
  job_type: nullableString,
  category: nullableString,
  url: z.string().url(),
  salary_min: nullableNumber,
  salary_max: nullableNumber,
  salary_currency: nullableString,
  salary_raw: nullableString,
  salary_min_usd: nullableNumber,
  salary_max_usd: nullableNumber,
  salary_annual_usd: nullableNumber,
  description: z.string(),
  tags: z.array(z.string()),
  source_id: z.string().min(1),
  source_name: z.string().min(1),
  source_tier: z.number().int().min(1).max(2),
  posted_at: z.string().datetime({ offset: true }),
  ingested_at: z.string().datetime({ offset: true }),
  run_id: z.string().min(1).nullable().optional(),
  completeness_score: z.number().min(0).max(1),
  schema_version: z.literal(SCHEMA_VERSION)
}).passthrough();

const canonicalFieldSet = new Set(CANONICAL_FIELDS);

export function validateCanonicalJob(job) {
  const parsed = canonicalJobSchema.safeParse(job);
  const extraFields = Object.keys(job || {}).filter(key => !canonicalFieldSet.has(key));

  if (!parsed.success) {
    return {
      success: false,
      data: null,
      safeEvolutionFields: extraFields,
      errors: parsed.error.issues.map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code
      }))
    };
  }

  return {
    success: true,
    data: parsed.data,
    safeEvolutionFields: extraFields,
    errors: []
  };
}

function isPopulated(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function calculateCompletenessScore(job) {
  const fields = [
    'title',
    'company',
    'location',
    'url',
    'description',
    'posted_at',
    'job_type',
    'category',
    'is_remote',
    'salary_min',
    'salary_max',
    'salary_currency',
    'salary_raw',
    'tags'
  ];

  const populated = fields.filter(field => isPopulated(job[field])).length;
  return Number((populated / fields.length).toFixed(3));
}

const USD_RATES = {
  USD: 1,
  EUR: 1.09,
  GBP: 1.27,
  CAD: 0.73,
  AUD: 0.66,
  INR: 0.012,
  SGD: 0.74
};

export function normalizeSalaryToUsd({ salary_min, salary_max, salary_currency }) {
  const currency = salary_currency ? String(salary_currency).toUpperCase() : null;
  const rate = currency ? USD_RATES[currency] : null;
  const min = typeof salary_min === 'number' && Number.isFinite(salary_min) ? salary_min : null;
  const max = typeof salary_max === 'number' && Number.isFinite(salary_max) ? salary_max : null;

  if (!rate) {
    return {
      salary_min_usd: null,
      salary_max_usd: null,
      salary_annual_usd: null
    };
  }

  const minUsd = min === null ? null : Number((min * rate).toFixed(2));
  const maxUsd = max === null ? null : Number((max * rate).toFixed(2));
  const annual = minUsd !== null && maxUsd !== null
    ? (minUsd + maxUsd) / 2
    : (minUsd ?? maxUsd);

  return {
    salary_min_usd: minUsd,
    salary_max_usd: maxUsd,
    salary_annual_usd: annual === null ? null : Number(annual.toFixed(2))
  };
}

export function toUtcIso(value, fallback = new Date()) {
  if (value === null || value === undefined || value === '') {
    return new Date(fallback).toISOString();
  }

  if (typeof value === 'number') {
    const millis = value < 100000000000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }

  const raw = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw}Z`
    : raw;

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(fallback).toISOString();
  }

  return parsed.toISOString();
}
