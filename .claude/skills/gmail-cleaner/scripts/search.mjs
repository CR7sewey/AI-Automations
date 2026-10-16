#!/usr/bin/env node
// Read-only: show which emails match, grouped by sender. Never modifies anything.
import { parseArgs } from 'node:util';
import {
  buildQuery,
  criteriaOptions,
  getSummaries,
  limitOptions,
  listIds,
  parseLimit,
  printReport,
  run,
} from './lib/gmail.mjs';

const USAGE = `Usage: node search.mjs [criteria] [--max N] [--list] [--json]

Criteria (combined with AND):
  --from <sender>        address, domain or display name; repeat for OR
  --label <name>         Gmail label; repeat for OR
  --category <name>      promotions | social | updates | forums | purchases
  --older-than <N[dwmy]> e.g. 30d, 3m
  --newer-than <N[dwmy]> e.g. 7d
  --query, -q <string>   raw Gmail search syntax
  --preset <name>        a named set from references/presets.json
Output:
  --latest N             only the N newest matches (needs at least one criterion)
  --max N                cap on matches inspected (default 500)
  --list                 print every message, not just the sender summary
  --json                 machine-readable output`;

run(async () => {
  const { values } = parseArgs({
    options: {
      ...criteriaOptions,
      ...limitOptions,
      list: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(USAGE);

  const { q, hasCriteria } = await buildQuery(values);
  if (!hasCriteria) throw new Error(`Give at least one criterion.\n\n${USAGE}`);
  const { max, latest } = parseLimit(values);

  console.error(`Query: ${q}`);
  const { ids, truncated } = await listIds(q, max);
  const summaries = await getSummaries(ids);
  if (values.json) return console.log(JSON.stringify({ query: q, truncated, messages: summaries }, null, 2));
  printReport(summaries, { truncated, max, latest, list: values.list });
});
