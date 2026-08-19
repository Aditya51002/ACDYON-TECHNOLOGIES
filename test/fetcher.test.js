import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBackoffWithJitter, fetchWithRetry } from '../src/fetcher.js';

test('Fetcher - Backoff and Jitter calculation', () => {
  const baseMs = 500;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const delay = calculateBackoffWithJitter(attempt, baseMs);
    const maxExpected = baseMs * Math.pow(2, attempt - 1);
    assert.ok(delay >= 0, `Delay should be non-negative: ${delay}`);
    assert.ok(delay <= maxExpected, `Delay ${delay} should not exceed max ${maxExpected}`);
  }
});

test('Fetcher - Retries on retryable 500 status and succeeds', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    if (callCount < 2) {
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Map()
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => [{ title: 'Software Engineer', company: 'Acme' }]
    };
  };

  const result = await fetchWithRetry('https://api.example.com/jobs', {
    maxAttempts: 3,
    rateLimitMs: 0,
    fetchFn: mockFetch
  });

  assert.equal(callCount, 2, 'Should have retried once before succeeding');
  assert.equal(result.attempts, 2);
  assert.equal(result.fromCache, false);
  assert.equal(result.data[0].title, 'Software Engineer');
});

test('Fetcher - Throws after exhausting retry attempts on continuous 500', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return {
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Map()
    };
  };

  await assert.rejects(
    async () => {
      await fetchWithRetry('https://api.example.com/fail', {
        maxAttempts: 3,
        rateLimitMs: 0,
        fetchFn: mockFetch
      });
    },
    /HTTP Error 503/
  );

  assert.equal(callCount, 3, 'Should have attempted exactly 3 times');
});
