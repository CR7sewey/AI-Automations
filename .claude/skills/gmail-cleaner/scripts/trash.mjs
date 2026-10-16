#!/usr/bin/env node
// Move matching emails to Trash (recoverable for 30 days). Dry run unless --apply.
// Never deletes permanently: the granted scope does not allow it, by design.
import { parseArgs } from 'node:util';
import {
  batchModify,
  buildQuery,
  criteriaOptions,
  describeLimit,
  getSummaries,
  limitOptions,
  listIds,
  parseLimit,
  printReport,
  run,
  selectIds,
} from './lib/gmail.mjs';

const USAGE = `Usage: node trash.mjs [criteria] [--apply] [options]

Criteria are the same as search.mjs (--from, --label, --category, --older-than,
--newer-than, --query, --preset). At least one is required.

Safety:
  (default)              dry run: shows what WOULD be trashed, changes nothing
  --apply                actually move the matches to Trash
  --exclude-id <id>      keep this message out of the batch; repeatable
  --include-starred      also trash starred emails (default: starred are kept)
  --keep-important       keep emails Gmail marks as Important
  --latest N             only the N newest matches, e.g. "delete the last 3 from X"
  --oldest N             only the N oldest matches, e.g. "delete the oldest 2000"
                         (both still need at least one criterion)
  --max N                safety cap: refuse to act on more than N emails (default
                         500). A larger --latest/--oldest/--no-summary run must
                         pass --max with at least that count.
  --list                 print every message, not just the sender summary
  --no-summary           skip fetching per-email details (fast, for thousands of
                         emails); only the match count is shown. Preview the
                         sender breakdown first, without this flag.`;

run(async () => {
  const { values } = parseArgs({
    options: {
      ...criteriaOptions,
      apply: { type: 'boolean' },
      'exclude-id': { type: 'string', multiple: true },
      'include-starred': { type: 'boolean' },
      'keep-important': { type: 'boolean' },
      'no-summary': { type: 'boolean' },
      ...limitOptions,
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(USAGE);

  const base = [];
  if (!values['include-starred']) base.push('-is:starred');
  if (values['keep-important']) base.push('-is:important');
  const { q, hasCriteria } = await buildQuery(values, base);
  if (!hasCriteria) throw new Error(`Give at least one criterion.\n\n${USAGE}`);

  const limit = parseLimit(values);
  const { max, latest, oldest, limited } = limit;
  const excluded = new Set(values['exclude-id'] ?? []);
  console.error(`Query: ${q}`);
  const found = await selectIds(q, limit);
  const ids = found.ids.filter((id) => !excluded.has(id));
  if (values['no-summary']) {
    const note = describeLimit({ latest, oldest, truncated: found.truncated, max }, ids.length);
    console.log(`Matched ${ids.length} email(s)${note}; sender summary skipped (--no-summary)`);
  } else {
    const summaries = await getSummaries(ids);
    printReport(summaries, { truncated: found.truncated, max, latest, oldest, list: values.list });
  }
  if (excluded.size) console.log(`\nExcluded by id: ${excluded.size}`);

  if (!values.apply) return console.log('\nDRY RUN: nothing was changed. Re-run with --apply to move these to Trash.');
  if (found.truncated && !limited) throw new Error(`More than ${max} matches. Narrow the criteria or raise --max.`);
  if (!ids.length) return console.log('\nNothing to do.');

  await batchModify(ids, { add: ['TRASH'], remove: ['INBOX'] });
  const left = await listIds(q, 500);
  console.log(`\nMoved ${ids.length} email(s) to Trash. Still matching outside Trash: ${left.ids.length}${left.truncated ? '+' : ''}.`);
});
