#!/usr/bin/env node
// Manage Gmail filters so future mail from a sender is handled automatically,
// server-side. `create` and `delete` are dry runs unless --apply.
import { parseArgs } from 'node:util';
import { api, run } from './lib/gmail.mjs';

const USAGE = `Usage:
  node filters.mjs list
  node filters.mjs create (--from <x> | --subject <x> | --query <x>) [--action trash|archive|read] [--apply]
  node filters.mjs delete --id <filterId> [--apply]

Actions for create (default: trash):
  trash    skip the inbox and move to Trash
  archive  skip the inbox, keep the mail
  read     mark as read, leave in the inbox

Filters only affect mail that arrives AFTER they are created. Use trash.mjs for
mail that is already in the mailbox.`;

const ACTIONS = {
  trash: { addLabelIds: ['TRASH'] }, // Gmail stores trash filters without the INBOX removal
  archive: { removeLabelIds: ['INBOX'] },
  read: { removeLabelIds: ['UNREAD'] },
};

const describe = (f) => `${f.id}  criteria=${JSON.stringify(f.criteria)}  action=${JSON.stringify(f.action)}`;
const listFilters = async () => (await api('/settings/filters')).filter ?? [];

run(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      subject: { type: 'string' },
      query: { type: 'string', short: 'q' },
      action: { type: 'string', default: 'trash' },
      id: { type: 'string' },
      apply: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command] = positionals;
  if (values.help || !command) return console.log(USAGE);

  if (command === 'list') {
    const filters = await listFilters();
    return console.log(filters.length ? filters.map(describe).join('\n') : 'No filters.');
  }

  if (command === 'create') {
    const criteria = Object.fromEntries(
      Object.entries({ from: values.from, subject: values.subject, query: values.query }).filter(([, v]) => v),
    );
    if (!Object.keys(criteria).length) throw new Error(`Give --from, --subject or --query.\n\n${USAGE}`);
    const action = ACTIONS[values.action];
    if (!action) throw new Error(`Unknown --action "${values.action}". Use: ${Object.keys(ACTIONS).join(', ')}`);

    const duplicate = (await listFilters()).find(
      (f) => JSON.stringify(f.criteria) === JSON.stringify(criteria) && JSON.stringify(f.action) === JSON.stringify(action),
    );
    if (duplicate) return console.log(`Identical filter already exists: ${describe(duplicate)}`);

    console.log(`Filter: criteria=${JSON.stringify(criteria)} action=${JSON.stringify(action)}`);
    if (!values.apply) return console.log('DRY RUN: nothing was created. Re-run with --apply.');
    const created = await api('/settings/filters', { method: 'POST', body: { criteria, action } });
    return console.log(`Created filter ${created.id}`);
  }

  if (command === 'delete') {
    if (!values.id) throw new Error('Give --id <filterId> (see: filters.mjs list).');
    const target = (await listFilters()).find((f) => f.id === values.id);
    if (!target) throw new Error(`No filter with id ${values.id}.`);
    console.log(`Filter: ${describe(target)}`);
    if (!values.apply) return console.log('DRY RUN: nothing was deleted. Re-run with --apply.');
    await api(`/settings/filters/${values.id}`, { method: 'DELETE' });
    return console.log('Deleted.');
  }

  throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
});
