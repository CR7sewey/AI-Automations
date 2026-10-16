import './support/env.mjs';
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const { api } = await import('../scripts/lib/gmail.mjs');

// The module keeps pacing/pause state across calls, so each test starts at a later fake "now".
let epoch = 1_800_000_000_000;
let calls;
let script; // array of handlers or Response factories, consumed in order

const res = (status, body = {}, headers = {}) => () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const netError = (code) => () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
};

function stubFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const call = { url: u, method: opts.method ?? 'GET', auth: opts.headers?.Authorization, at: Date.now() };
    calls.push(call);
    if (u.hostname === 'oauth.invalid') return new Response(JSON.stringify({ access_token: 'new-access', expires_in: 1_000_000_000 /* keeps the refreshed token valid across the later fake clocks */ }), { status: 200 });
    const next = script.shift();
    assert.ok(next, `unexpected extra fetch to ${u.pathname}`);
    return next();
  };
}

// Run a promise to completion while advancing mocked time in 1s steps.
async function drive(promise) {
  let outcome;
  promise.then((value) => (outcome = { value }), (error) => (outcome = { error }));
  for (let i = 0; i < 400 && !outcome; i++) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(1000);
  }
  await new Promise((r) => setImmediate(r));
  assert.ok(outcome, 'request did not settle within 400 simulated seconds');
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

const apiCalls = () => calls.filter((c) => c.url.hostname !== 'oauth.invalid');
const refreshCalls = () => calls.filter((c) => c.url.hostname === 'oauth.invalid');

describe('api()', () => {
  const realError = console.error;
  beforeEach(() => {
    epoch += 10_000_000;
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: epoch });
    calls = [];
    script = [];
    stubFetch();
    console.error = () => {}; // silence pause notices
  });
  afterEach(() => {
    mock.timers.reset();
    console.error = realError;
  });

  test('returns parsed JSON on success and sends the bearer token', async () => {
    script = [res(200, { ok: 1 })];
    assert.deepEqual(await drive(api('/messages')), { ok: 1 });
    assert.equal(apiCalls()[0].auth, 'Bearer fake-access');
  });

  test('a 204 returns null', async () => {
    script = [() => new Response(null, { status: 204 })];
    assert.equal(await drive(api('/settings/filters/x', { method: 'DELETE' })), null);
  });

  test('a 401 triggers exactly one token refresh then retries with the new token', async () => {
    script = [res(401, 'expired'), res(200, { ok: 2 })];
    assert.deepEqual(await drive(api('/messages')), { ok: 2 });
    assert.equal(refreshCalls().length, 1);
    assert.equal(apiCalls().length, 2);
    assert.equal(apiCalls()[1].auth, 'Bearer new-access');
  });

  test('a second 401 throws instead of looping', async () => {
    script = [res(401, 'nope'), res(401, 'still nope')];
    await assert.rejects(drive(api('/messages')), /-> 401/);
    assert.equal(refreshCalls().length, 1);
    assert.equal(apiCalls().length, 2);
  });

  test('a 429 pauses at least 10s then retries', async () => {
    script = [res(429, 'slow down'), res(200, { ok: 3 })];
    assert.deepEqual(await drive(api('/messages')), { ok: 3 });
    const [first, second] = apiCalls();
    assert.ok(second.at - first.at >= 10_000, `gap was ${second.at - first.at}ms`);
  });

  test('a 403 userRateLimitExceeded is retried', async () => {
    script = [res(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), res(200, { ok: 4 })];
    assert.deepEqual(await drive(api('/messages')), { ok: 4 });
    assert.equal(apiCalls().length, 2);
  });

  test('a 403 dailyLimitExceeded is NOT retried', async () => {
    script = [res(403, { error: { errors: [{ reason: 'dailyLimitExceeded' }] } })];
    await assert.rejects(drive(api('/messages')), /-> 403/);
    assert.equal(apiCalls().length, 1);
  });

  test('a plain 403 (no rate limit wording) is not retried', async () => {
    script = [res(403, 'Insufficient Permission')];
    await assert.rejects(drive(api('/messages')), /-> 403: Insufficient Permission/);
    assert.equal(apiCalls().length, 1);
  });

  test('Retry-After longer than the default backoff is honored', async () => {
    script = [res(429, 'slow', { 'retry-after': '30' }), res(200, { ok: 5 })];
    await drive(api('/messages'));
    const [first, second] = apiCalls();
    assert.ok(second.at - first.at >= 30_000, `gap was ${second.at - first.at}ms`);
  });

  test('GET network errors are retried', async () => {
    script = [netError('ECONNRESET'), res(200, { ok: 6 })];
    assert.deepEqual(await drive(api('/messages')), { ok: 6 });
    assert.equal(apiCalls().length, 2);
  });

  test('a POST to /settings/filters is not retried on a network error', async () => {
    script = [netError('ECONNRESET')];
    await assert.rejects(
      drive(api('/settings/filters', { method: 'POST', body: { criteria: {}, action: {} } })),
      /POST \/settings\/filters failed: ECONNRESET/,
    );
    assert.equal(apiCalls().length, 1);
  });

  test('batchModify POSTs are treated as idempotent and retried on network errors', async () => {
    script = [netError('ECONNRESET'), res(200, {})];
    await drive(api('/messages/batchModify', { method: 'POST', body: { ids: ['a'] } }));
    assert.equal(apiCalls().length, 2);
  });

  test('a 404 has a readable message with method, endpoint, status and body', async () => {
    script = [res(404, { error: { message: 'Requested entity was not found.' } })];
    await assert.rejects(drive(api('/messages/zzz')), (err) => {
      assert.match(err.message, /Gmail API GET \/messages\/zzz -> 404:/);
      assert.match(err.message, /Requested entity was not found/);
      return true;
    });
    assert.equal(apiCalls().length, 1);
  });

  test('5xx responses are retried', async () => {
    script = [res(503, 'unavailable'), res(200, { ok: 7 })];
    assert.deepEqual(await drive(api('/messages')), { ok: 7 });
  });

  test('array query values are appended repeatedly and undefined values are skipped', async () => {
    script = [res(200, {})];
    await drive(api('/messages/1', { query: { metadataHeaders: ['From', 'Date'], pageToken: undefined } }));
    const u = apiCalls()[0].url;
    assert.deepEqual(u.searchParams.getAll('metadataHeaders'), ['From', 'Date']);
    assert.equal(u.searchParams.has('pageToken'), false);
  });
});
