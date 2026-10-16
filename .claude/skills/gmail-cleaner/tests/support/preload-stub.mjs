// Preloaded into CLI child processes via --import. Replaces fetch with a fake Gmail and logs
// every request as JSON lines to $STUB_LOG. $STUB_COUNT = number of matching messages.
import { appendFileSync } from 'node:fs';

const count = Number(process.env.STUB_COUNT ?? 2);
const ids = Array.from({ length: count }, (_, i) => `m${i}`);

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const method = opts.method ?? 'GET';
  appendFileSync(
    process.env.STUB_LOG,
    JSON.stringify({ method, path: u.pathname, q: u.searchParams.get('q'), body: opts.body ? JSON.parse(opts.body) : null }) + '\n',
  );
  const json = (o) => new Response(JSON.stringify(o), { status: 200 });
  if (u.pathname.endsWith('/batchModify')) return json({});
  if (u.pathname.endsWith('/messages')) {
    const start = Number(u.searchParams.get('pageToken') ?? 0);
    const end = Math.min(start + 500, ids.length);
    return json({ messages: ids.slice(start, end).map((id) => ({ id })), nextPageToken: end < ids.length ? String(end) : undefined });
  }
  const i = Number(u.pathname.split('/').pop().slice(1)); // newest first: higher index = older
  return json({
    id: `m${i}`,
    internalDate: String(2_000_000_000_000 - i * 1000),
    labelIds: ['INBOX'],
    payload: { headers: [{ name: 'From', value: `Sender <s${i}@example.com>` }, { name: 'Subject', value: `s${i}` }, { name: 'Date', value: 'Mon, 1 Jan 2024 00:00:00 +0000' }] },
  });
};
