import './support/env.mjs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeGmail } from './support/fake-gmail.mjs';

const { parseLimit, selectIds, describeLimit, buildQuery } = await import('../scripts/lib/gmail.mjs');

describe('parseLimit', () => {
  test('defaults max to 500 when nothing is given', () => {
    assert.deepEqual(parseLimit({}), { max: 500, latest: undefined, oldest: undefined, limited: false });
  });

  test('uses an explicit --max without a limiter', () => {
    const r = parseLimit({ max: '1200' });
    assert.equal(r.max, 1200);
    assert.equal(r.limited, false);
  });

  test('returns max equal to the count when --latest is set', () => {
    const r = parseLimit({ latest: '3' });
    assert.deepEqual(r, { max: 3, latest: 3, oldest: undefined, limited: true });
  });

  test('returns max equal to the count when --oldest is set', () => {
    const r = parseLimit({ oldest: '40', max: '100' });
    assert.deepEqual(r, { max: 40, latest: undefined, oldest: 40, limited: true });
  });

  test('rejects --latest together with --oldest', () => {
    assert.throws(() => parseLimit({ latest: '1', oldest: '1' }), /either --latest or --oldest/);
  });

  for (const bad of ['abc', '0', '-5', '1.5', '']) {
    test(`rejects non-positive-integer --latest "${bad}"`, () => {
      assert.throws(() => parseLimit({ latest: bad }), /positive integer/);
    });
  }

  test('rejects an invalid --max', () => {
    assert.throws(() => parseLimit({ max: '0' }), /--max must be a positive integer/);
  });

  test('throws when --oldest exceeds the default cap and tells the user to pass --max', () => {
    assert.throws(() => parseLimit({ oldest: '501' }), /--oldest 501 exceeds.*Pass --max 501/);
  });

  test('allows count equal to the cap', () => {
    assert.equal(parseLimit({ latest: '500' }).max, 500);
  });

  test('a raised --max lets a larger --latest through', () => {
    assert.equal(parseLimit({ latest: '2000', max: '2000' }).max, 2000);
  });

  test('enforceCap:false skips the cap check', () => {
    const r = parseLimit({ latest: '9999' }, { enforceCap: false });
    assert.equal(r.max, 9999);
    assert.equal(r.limited, true);
  });
});

describe('selectIds + assertNewestFirst', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const newestFirst = { a: 5000, b: 4000, c: 3000, d: 2000, e: 1000 };
  const oldestFirst = { a: 1000, b: 2000, c: 3000, d: 4000, e: 5000 };

  test('--latest N returns the first N of the list', async () => {
    installFakeGmail({ ids, dates: newestFirst });
    const r = await selectIds('q', { max: 2, latest: 2 });
    assert.deepEqual(r.ids, ['a', 'b']);
  });

  test('--oldest N returns the last N of the full list, never truncated', async () => {
    installFakeGmail({ ids, dates: newestFirst });
    const r = await selectIds('q', { max: 2, oldest: 2 });
    assert.deepEqual(r, { ids: ['d', 'e'], truncated: false });
  });

  test('--oldest pages through the entire result set', async () => {
    const many = Array.from({ length: 700 }, (_, i) => `i${i}`);
    const dates = Object.fromEntries(many.map((id, i) => [id, 9e12 - i]));
    const calls = installFakeGmail({ ids: many, dates });
    const r = await selectIds('q', { max: 3, oldest: 3 });
    assert.deepEqual(r.ids, ['i697', 'i698', 'i699']);
    assert.equal(calls.filter((c) => c.path.endsWith('/messages')).length, 2);
  });

  test('--latest throws when the first message is older than the last', async () => {
    installFakeGmail({ ids, dates: oldestFirst });
    await assert.rejects(selectIds('q', { max: 2, latest: 2 }), /oldest-first/);
  });

  test('--oldest throws when the list is oldest-first', async () => {
    installFakeGmail({ ids, dates: oldestFirst });
    await assert.rejects(selectIds('q', { max: 2, oldest: 2 }), /oldest-first/);
  });

  test('fewer matches than N returns them all', async () => {
    installFakeGmail({ ids: ['a', 'b'], dates: { a: 2, b: 1 } });
    assert.deepEqual((await selectIds('q', { max: 10, oldest: 10 })).ids, ['a', 'b']);
    assert.deepEqual((await selectIds('q', { max: 10, latest: 10 })).ids, ['a', 'b']);
  });

  test('without a limiter, reports truncated when more than max exist', async () => {
    installFakeGmail({ ids, dates: newestFirst });
    const r = await selectIds('q', { max: 3 });
    assert.deepEqual(r, { ids: ['a', 'b', 'c'], truncated: true });
  });

  test('a single match needs no date check', async () => {
    const calls = installFakeGmail({ ids: ['a'], dates: { a: 1 } });
    await selectIds('q', { max: 1, latest: 1 });
    assert.equal(calls.length, 1);
  });
});

describe('describeLimit', () => {
  test('latest', () => {
    assert.equal(describeLimit({ latest: 3, max: 3 }, 3), ' (the latest 3 only, newest first)');
  });
  test('oldest', () => {
    assert.equal(describeLimit({ oldest: 4, max: 4 }, 4), ' (the oldest 4 only)');
  });
  test('fewer than N', () => {
    assert.equal(describeLimit({ oldest: 10, max: 10 }, 2), ' (all 2 matches, fewer than --oldest 10)');
    assert.equal(describeLimit({ latest: 10, max: 10 }, 0), ' (all 0 matches, fewer than --latest 10)');
  });
  test('truncated', () => {
    assert.equal(describeLimit({ truncated: true, max: 500 }, 500), ' (more exist beyond --max 500)');
  });
  test('none', () => {
    assert.equal(describeLimit({ truncated: false, max: 500 }, 5), '');
  });
});

describe('buildQuery', () => {
  test('ANDs all criteria in a stable order', async () => {
    const r = await buildQuery({
      from: ['a.com'], label: ['work'], category: 'promotions', 'older-than': '30d', 'newer-than': '1y', query: 'has:attachment',
    });
    assert.equal(r.q, 'from:a.com label:work category:promotions older_than:30d newer_than:1y has:attachment');
    assert.equal(r.hasCriteria, true);
  });

  test('repeated --from becomes a parenthesised OR group', async () => {
    const r = await buildQuery({ from: ['a', 'b'] });
    assert.equal(r.q, '(from:a OR from:b)');
  });

  test('values with spaces are quoted; already quoted ones are not double quoted', async () => {
    assert.equal((await buildQuery({ from: ['Daily Digest'] })).q, 'from:"Daily Digest"');
    assert.equal((await buildQuery({ from: ['"Daily Digest"'] })).q, 'from:"Daily Digest"');
  });

  test('base terms are appended but are not criteria', async () => {
    const none = await buildQuery({}, ['-is:starred']);
    assert.deepEqual(none, { q: '-is:starred', hasCriteria: false });
    const some = await buildQuery({ from: ['a'] }, ['-is:starred', 'in:trash']);
    assert.deepEqual(some, { q: 'from:a -is:starred in:trash', hasCriteria: true });
  });

  test('empty input yields an empty query and no criteria', async () => {
    assert.deepEqual(await buildQuery({}), { q: '', hasCriteria: false });
  });

  test('preset merges with CLI flags (from lists concatenate, CLI scalars win)', async () => {
    const r = await buildQuery({ preset: 'newsletters', from: ['extra.com'] });
    assert.equal(r.q, '(from:buscojobs.com OR from:info@news.thefork.pt OR from:"Medium Daily Digest" OR from:extra.com)');
    const p = await buildQuery({ preset: 'old-promotions', 'older-than': '60d', query: 'foo' });
    assert.equal(p.q, 'category:promotions older_than:60d foo');
    assert.equal(p.hasCriteria, true);
  });

  test('unknown preset throws and lists the available ones', async () => {
    await assert.rejects(buildQuery({ preset: 'nope' }), /Unknown preset "nope".*newsletters/);
  });
});
