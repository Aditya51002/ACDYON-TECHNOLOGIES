import { getRawCache, saveRawCache } from './db.js';

// Domain-level rate limiter timestamps
const domainLastRequestTime = new Map();

/**
 * Sleep helper with promise
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff with full randomized jitter
 * Base: 1000ms, factor: 2, jitter: random between 0 and full delay
 * @param {number} attempt Attempt number (1, 2, 3)
 * @param {number} baseMs Base backoff milliseconds (default: 800ms)
 * @returns {number} Jittered delay in ms
 */
export function calculateBackoffWithJitter(attempt, baseMs = 800) {
  const maxDelay = baseMs * Math.pow(2, attempt - 1);
  // Full jitter: uniformly random between 0 and maxDelay
  const jittered = Math.floor(Math.random() * maxDelay);
  return jittered;
}

/**
 * Extract hostname from URL
 */
function getHostname(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname;
  } catch {
    return 'default';
  }
}

/**
 * Self-imposed polite rate limiter per domain
 */
async function enforceDomainRateLimit(urlStr, minIntervalMs = 1000) {
  const hostname = getHostname(urlStr);
  const now = Date.now();
  const lastTime = domainLastRequestTime.get(hostname) || 0;
  const elapsed = now - lastTime;

  if (elapsed < minIntervalMs) {
    const waitTime = minIntervalMs - elapsed;
    await sleep(waitTime);
  }
  domainLastRequestTime.set(hostname, Date.now());
}

/**
 * Fetch with retry, exponential backoff, jitter, timeout, and polite rate limiting
 * @param {string} url Endpoint URL
 * @param {Object} options
 * @param {number} [options.maxAttempts=3]
 * @param {number} [options.timeoutMs=8000]
 * @param {number} [options.rateLimitMs=1000]
 * @param {Object} [options.headers={}]
 * @param {Function} [options.fetchFn=fetch] Custom fetch function for unit testing
 * @returns {Promise<{ data: any, headers: Headers, attempts: number, fromCache: boolean }>}
 */
export async function fetchWithRetry(url, {
  maxAttempts = 3,
  timeoutMs = 8000,
  rateLimitMs = 1000,
  headers = {},
  fetchFn = fetch
} = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Enforce self-imposed domain rate limiting
      await enforceDomainRateLimit(url, rateLimitMs);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const defaultHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 JobPipelineBot/1.0 (Integration; +https://github.com/job-pipeline)',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers
      };

      const response = await fetchFn(url, {
        signal: controller.signal,
        headers: defaultHeaders
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Status 4xx (except 429) usually non-retryable; 429 and 5xx are retryable
        const isRetryable = response.status === 429 || (response.status >= 500 && response.status < 600);
        const err = new Error(`HTTP Error ${response.status}: ${response.statusText}`);
        err.status = response.status;
        err.isRetryable = isRetryable;

        if (!isRetryable || attempt === maxAttempts) {
          throw err;
        }

        lastError = err;
        const delay = calculateBackoffWithJitter(attempt);
        await sleep(delay);
        continue;
      }

      const contentType = response.headers?.get?.('content-type') || '';
      let data;
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        const text = await response.text();
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      return {
        data,
        headers: response.headers,
        attempts: attempt,
        fromCache: false
      };

    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') {
        lastError = new Error(`Request timed out after ${timeoutMs}ms`);
      }

      if (attempt < maxAttempts) {
        const delay = calculateBackoffWithJitter(attempt);
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error(`Failed to fetch ${url} after ${maxAttempts} attempts`);
}

/**
 * Fetch source data with automatic fallback to last-known-good cache on failure
 * @param {Object} sourceConfig
 * @param {Object} options
 * @returns {Promise<{ data: any, fromCache: boolean, attempts: number, error: Error|null }>}
 */
export async function fetchWithFallback(sourceConfig, options = {}) {
  const { id: sourceId, endpoint, rate_limit_ms } = sourceConfig;
  const { simulateFailure = false, simulateDrift = false, customFetch = null } = options;

  // Handle synthetic test simulations
  if (simulateFailure) {
    // Try to retrieve fallback cache
    const cached = getRawCache(sourceId);
    if (cached) {
      return {
        data: cached.data,
        fromCache: true,
        attempts: 1,
        error: new Error('Simulated upstream failure: Activated last-known-good cache fallback')
      };
    }
    throw new Error(`Simulated upstream failure: No fallback cache available for source ${sourceId}`);
  }

  try {
    const result = await fetchWithRetry(endpoint, {
      rateLimitMs: rate_limit_ms || 1000,
      fetchFn: customFetch || fetch,
      ...options
    });

    if (simulateDrift) {
      // Corrupt the shape to trigger schema drift detection downstream
      return {
        data: [{ corrupted_key: 'invalid_data', foo: 123, broken_schema: true }],
        fromCache: false,
        attempts: result.attempts,
        error: null
      };
    }

    return {
      data: result.data,
      fromCache: false,
      attempts: result.attempts,
      error: null
    };

  } catch (fetchError) {
    // Attempt last-known-good cache fallback
    const cached = getRawCache(sourceId);
    if (cached) {
      return {
        data: cached.data,
        fromCache: true,
        attempts: 3,
        error: fetchError
      };
    }

    // No cache available, throw hard error
    throw fetchError;
  }
}
