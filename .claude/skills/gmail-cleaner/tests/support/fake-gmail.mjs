// In-process fake Gmail for list/get endpoints. Replaces globalThis.fetch; records calls.
export function installFakeGmail({ ids, dates }) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    calls.push({ method: opts.method ?? 'GET', path: u.pathname, search: u.searchParams });
    const json = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (u.pathname.endsWith('/messages')) {
      const start = Number(u.searchParams.get('pageToken') ?? 0);
      const end = Math.min(start + 500, ids.length);
      return json({ messages: ids.slice(start, end).map((id) => ({ id })), nextPageToken: end < ids.length ? String(end) : undefined });
    }
    const id = u.pathname.split('/').pop();
    return json({ id, internalDate: String(dates[id]) });
  };
  return calls;
}
