#!/usr/bin/env node
// Undo: move matching emails from Trash back to the inbox. Dry run unless --apply.
import { parseArgs } from 'node:util';
import {
  batchModify,
  buildQuery,
  criteriaOptions,
  getSummaries,
  limitOptions,
  listIds,
  parseLimit,
  printReport,
  run,
} from './lib/gmail.mjs';

const USAGE = `Usage: node restore.mjs [criteria] [--apply] [--latest N] [--max N] [--list]

Criteria are the same as search.mjs (--from, --label, --category, --older-than,
--newer-than, --query, --preset). At least one is required. Only mail currently in
Trash is considered. Restored mail returns to the inbox.`;

run(async () => {
  const { values } = parseArgs({
    options: {
      ...criteriaOptions,
      apply: { type: 'boolean' },
      ...limitOptions,
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(USAGE);

  const { q, hasCriteria } = await buildQuery(values, ['in:trash']);
  if (!hasCriteria) throw new Error(`Give at least one criterion.\n\n${USAGE}`);

  const { max, latest } = parseLimit(values);
  console.error(`Query: ${q}`);
  const { ids, truncated } = await listIds(q, max);
  const summaries = await getSummaries(ids);
  printReport(summaries, { truncated, max, latest, list: values.list });

  if (!values.apply) return console.log('\nDRY RUN: nothing was changed. Re-run with --apply to restore these.');
  if (truncated && !latest) throw new Error(`More than ${max} matches. Narrow the criteria or raise --max.`);
  if (!ids.length) return console.log('\nNothing to do.');

  await batchModify(ids, { add: ['INBOX'], remove: ['TRASH'] });
  console.log(`\nRestored ${ids.length} email(s) to the inbox.`);
});
