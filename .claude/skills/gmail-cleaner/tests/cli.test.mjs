import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dir } from './support/env.mjs';

const scripts = path.resolve(import.meta.dirname, '../scripts');
const preload = pathToFileURL(path.resolve(import.meta.dirname, 'support/preload-stub.mjs')).href;
const logFile = path.join(dir, 'requests.jsonl');

function cli(script, args, { count = 2 } = {}) {
  writeFileSync(logFile, '');
  const r = spawnSync(process.execPath, ['--import', preload, path.join(scripts, script), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, GMAIL_CLEANER_DIR: dir, STUB_LOG: logFile, STUB_COUNT: String(count) },
  });
  const requests = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...r, requests, modifies: requests.filter((q) => q.method === 'POST' && q.path.endsWith('/messages/batchModify')) };
}

describe('trash.mjs', () => {
  test('exits non-zero with no criteria and makes no requests', () => {
    const r = cli('trash.mjs', []);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /at least one criterion/);
    assert.equal(r.requests.length, 0);
  });

  test('only base terms (--include-starred, --keep-important) do not count as criteria', () => {
    const r = cli('trash.mjs', ['--keep-important', '--apply']);
    assert.notEqual(r.status, 0);
    assert.equal(r.modifies.length, 0);
  });

  test('without --apply it is a dry run and never POSTs batchModify', () => {
    const r = cli('trash.mjs', ['--from', 'a@b.com']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN/);
    assert.equal(r.modifies.length, 0);
    assert.equal(r.requests.some((q) => q.method !== 'GET' && !q.path.endsWith('/token')), false);
  });

  test('the query excludes starred mail by default', () => {
    const r = cli('trash.mjs', ['--from', 'a@b.com']);
    assert.match(r.requests.find((q) => q.path.endsWith('/messages')).q, /from:a@b\.com -is:starred/);
  });

  test('--apply sends exactly one batchModify that adds TRASH for both messages', () => {
    const r = cli('trash.mjs', ['--from', 'a@b.com', '--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.modifies.length, 1);
    const { ids, addLabelIds, removeLabelIds } = r.modifies[0].body;
    assert.deepEqual(ids, ['m0', 'm1']);
    assert.ok(addLabelIds.includes('TRASH'));
    assert.ok(!removeLabelIds.includes('TRASH'));
    assert.match(r.stdout, /Moved 2 email/);
  });

  test('--exclude-id removes that message from the batch', () => {
    const r = cli('trash.mjs', ['--from', 'a@b.com', '--apply', '--exclude-id', 'm0']);
    assert.deepEqual(r.modifies[0].body.ids, ['m1']);
  });

  test('--oldest above the default cap exits non-zero and touches nothing', () => {
    const r = cli('trash.mjs', ['--from', 'a@b.com', '--oldest', '501', '--apply'], { count: 600 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--max 501/);
    assert.equal(r.requests.length, 0);
  });

  test('--oldest above the cap succeeds once --max is raised (dry run, no summary)', () => {
    const r = cli('trash.mjs', ['--from', 'a@b.com', '--oldest', '501', '--max', '501', '--no-summary'], { count: 600 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Matched 501 email\(s\) \(the oldest 501 only\)/);
    assert.equal(r.modifies.length, 0);
  });

  test('--latest and --oldest together exit non-zero', () => {
    const r = cli('trash.mjs', ['--from', 'a', '--latest', '1', '--oldest', '1']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not both/);
  });
});

describe('restore.mjs', () => {
  test('exits non-zero with no criteria and makes no requests', () => {
    const r = cli('restore.mjs', ['--apply']);
    assert.notEqual(r.status, 0);
    assert.equal(r.requests.length, 0);
  });

  test('without --apply it never POSTs batchModify and searches in:trash', () => {
    const r = cli('restore.mjs', ['--from', 'a@b.com']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN/);
    assert.equal(r.modifies.length, 0);
    assert.match(r.requests.find((q) => q.path.endsWith('/messages')).q, /in:trash/);
  });

  test('--apply sends exactly one batchModify that adds INBOX and removes TRASH', () => {
    const r = cli('restore.mjs', ['--from', 'a@b.com', '--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.modifies.length, 1);
    assert.deepEqual(r.modifies[0].body, { ids: ['m0', 'm1'], addLabelIds: ['INBOX'], removeLabelIds: ['TRASH'] });
  });

  test('--oldest above the default cap exits non-zero', () => {
    const r = cli('restore.mjs', ['--from', 'a@b.com', '--oldest', '501', '--apply'], { count: 600 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--max 501/);
    assert.equal(r.modifies.length, 0);
  });
});

describe('search.mjs and filters.mjs', () => {
  test('search.mjs with --oldest runs read-only and never modifies', () => {
    const r = cli('search.mjs', ['--from', 'a@b.com', '--oldest', '2']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.modifies.length, 0);
  });

  test('filters.mjs create without --apply is a dry run and does not POST', () => {
    const r = cli('filters.mjs', ['create', '--from', 'spam@x.com']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN/);
    assert.equal(r.requests.some((q) => q.method === 'POST'), false);
  });

  test('filters.mjs create with no criteria exits non-zero', () => {
    const r = cli('filters.mjs', ['create']);
    assert.notEqual(r.status, 0);
  });
});
