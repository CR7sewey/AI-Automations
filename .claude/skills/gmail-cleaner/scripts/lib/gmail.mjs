// Shared helpers for the gmail-cleaner scripts: OAuth token handling, a Gmail REST
// client with retry/backoff, query building and report printing. No dependencies.
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CONFIG_DIR = process.env.GMAIL_CLEANER_DIR || path.join(homedir(), '.gmail-mcp');
const KEYS_FILE = path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'credentials.json');
const PRESETS_FILE = new URL('../../references/presets.json', import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- auth

let token;

async function loadJson(file, hint) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${file} (${err.code ?? err.message}). ${hint}`);
  }
}

async function loadToken() {
  token ??= await loadJson(TOKEN_FILE, 'Complete the one-time login described in SKILL.md (Setup).');
  return token;
}

async function refreshAccessToken() {
  const keys = await loadJson(KEYS_FILE, 'Put the Google OAuth client JSON there (see SKILL.md, Setup).');
  const { client_id, client_secret, token_uri } = keys.installed ?? keys.web ?? {};
  const current = await loadToken();
  const res = await fetch(token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      client_secret,
      refresh_token: current.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${data.error_description ?? data.error}. Redo the login (SKILL.md, Setup).`);
  }
  token = { ...current, access_token: data.access_token, expiry_date: Date.now() + data.expires_in * 1000 };
  await writeFile(TOKEN_FILE, JSON.stringify(token, null, 2));
}

async function accessToken() {
  const current = await loadToken();
  if (!current.access_token || (current.expiry_date ?? 0) < Date.now() + 60_000) await refreshAccessToken();
  return token.access_token;
}

export async function grantedScopes() {
  return ((await loadToken()).scope ?? '').split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------- REST client

// Gmail's quota page (checked 2026-10) lists 6,000 units/minute/user, with messages.get
// costing 20 units, i.e. about 5 fetches/s. Pace requests to that, and when Gmail still
// pushes back make every worker pause together instead of retrying on its own.
const MIN_INTERVAL_MS = 200;
const MAX_TOTAL_PAUSE_MS = 15 * 60_000;
let nextSlot = 0;
let pausedUntil = 0;
let totalPausedMs = 0;

async function throttle() {
  for (;;) {
    const now = Date.now();
    if (now < pausedUntil) {
      await sleep(pausedUntil - now);
      continue;
    }
    const at = Math.max(now, nextSlot);
    nextSlot = at + MIN_INTERVAL_MS;
    if (at > now) await sleep(at - now);
    if (Date.now() >= pausedUntil) return; // a pause may have started while we slept
  }
}

export async function api(endpoint, { method = 'GET', query = {}, body } = {}) {
  const url = new URL(API + endpoint);
  for (const [key, value] of Object.entries(query)) {
    for (const item of [].concat(value)) if (item !== undefined) url.searchParams.append(key, item);
  }
  const idempotent = method === 'GET' || endpoint.endsWith('/batchModify');
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          ...(body && { 'Content-Type': 'application/json' }),
        },
        body: body && JSON.stringify(body),
      });
    } catch (err) {
      if (idempotent && attempt < 4) {
        await sleep(2 ** attempt * 1000 + Math.random() * 250);
        continue;
      }
      throw new Error(`Gmail API ${method} ${endpoint} failed: ${err.cause?.code ?? err.message}`);
    }
    if (res.ok) return res.status === 204 ? null : res.json();

    const text = await res.text();
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await refreshAccessToken();
      continue;
    }
    // 429, or 403 rateLimitExceeded/userRateLimitExceeded. A daily limit will not clear in minutes.
    const rateLimited = res.status === 429 || (res.status === 403 && /rateLimit|quota/i.test(text));
    if (rateLimited && !/dailyLimit/i.test(text) && attempt < 8) {
      const retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || 0;
      const wait = Math.min(65_000, Math.max(10_000 * (attempt + 1), retryAfterMs));
      if (Date.now() + wait > pausedUntil) {
        totalPausedMs += wait;
        if (totalPausedMs > MAX_TOTAL_PAUSE_MS) {
          throw new Error('Gmail has rate limited this run for over 15 minutes in total; stopping. Re-run later.');
        }
        pausedUntil = Date.now() + wait;
        console.error(`  rate limited by Gmail, pausing ${Math.round(wait / 1000)}s...`);
      }
      continue;
    }
    if (res.status >= 500 && attempt < 6) {
      await sleep(2 ** attempt * 1000 + Math.random() * 250);
      continue;
    }
    throw new Error(`Gmail API ${method} ${endpoint} -> ${res.status}: ${text.slice(0, 300)}`);
  }
}

export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- messages

/** List message ids for a Gmail query. `truncated` is true when more than `max` match. */
export async function listIds(q, max = 500) {
  const ids = [];
  const includeSpamTrash = /\bin:(trash|spam|anywhere)\b/.test(q) || undefined;
  let pageToken;
  do {
    const page = await api('/messages', { query: { q, maxResults: 500, pageToken, includeSpamTrash } });
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length <= max);
  return { ids: ids.slice(0, max), truncated: ids.length > max };
}

export async function getSummaries(ids) {
  return mapPool(ids, 8, async (id) => {
    const msg = await api(`/messages/${id}`, {
      query: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] },
    });
    const h = Object.fromEntries((msg.payload?.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
    return { id, from: h.from ?? '', subject: h.subject ?? '', date: h.date ?? '', labels: msg.labelIds ?? [] };
  });
}

/** Add/remove labels in sequential chunks (Gmail rejects many concurrent writes). */
export async function batchModify(ids, { add = [], remove = [] }) {
  for (let i = 0; i < ids.length; i += 500) {
    await api('/messages/batchModify', {
      method: 'POST',
      body: { ids: ids.slice(i, i + 500), addLabelIds: add, removeLabelIds: remove },
    });
    console.error(`  modified ${Math.min(i + 500, ids.length)}/${ids.length}`);
  }
}

// ---------------------------------------------------------------- query building

export const criteriaOptions = {
  from: { type: 'string', multiple: true },
  label: { type: 'string', multiple: true },
  category: { type: 'string' },
  'older-than': { type: 'string' },
  'newer-than': { type: 'string' },
  query: { type: 'string', short: 'q' },
  preset: { type: 'string' },
};

const DEFAULT_MAX = 500;

export const limitOptions = {
  max: { type: 'string' }, // default DEFAULT_MAX; undefined means "not set explicitly"
  latest: { type: 'string' },
  oldest: { type: 'string' },
};

/**
 * `--latest N` keeps only the N newest matches, `--oldest N` only the N oldest; neither
 * is an error when more exist. `--max N` is the safety cap on how many emails one run may
 * act on (default 500), so a larger --latest/--oldest must be confirmed with a matching
 * --max. Read-only callers pass `enforceCap: false`.
 */
export function parseLimit(values, { enforceCap = true } = {}) {
  const parse = (name, raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got "${raw}".`);
    return n;
  };
  if (values.latest !== undefined && values.oldest !== undefined) {
    throw new Error('Use either --latest or --oldest, not both.');
  }
  const max = values.max === undefined ? DEFAULT_MAX : parse('max', values.max);
  const latest = values.latest === undefined ? undefined : parse('latest', values.latest);
  const oldest = values.oldest === undefined ? undefined : parse('oldest', values.oldest);
  const count = latest ?? oldest;
  if (enforceCap && count !== undefined && count > max) {
    const flag = latest ? 'latest' : 'oldest';
    throw new Error(`--${flag} ${count} exceeds the safety cap --max ${max}. Pass --max ${count} (or higher) to confirm.`);
  }
  return { max: count ?? max, latest, oldest, limited: count !== undefined };
}

/**
 * messages.list order is not documented; --latest/--oldest assume newest first. Compare the
 * first and last message dates (2 cheap fetches) and refuse to continue if that is wrong.
 */
async function assertNewestFirst(ids) {
  if (ids.length < 2) return;
  const dateOf = async (id) => Number((await api(`/messages/${id}`, { query: { format: 'minimal' } })).internalDate);
  const first = await dateOf(ids[0]);
  const last = await dateOf(ids[ids.length - 1]);
  if (first < last) throw new Error('Gmail listed messages oldest-first; --latest/--oldest assume newest-first. Aborting.');
}

/** Resolve the ids to act on, honouring --latest / --oldest / --max. */
export async function selectIds(q, { max, latest, oldest }) {
  if (!oldest) {
    const found = await listIds(q, max);
    if (latest) await assertNewestFirst(found.ids);
    return found;
  }
  const { ids } = await listIds(q, Infinity); // listing ids is cheap: 5 units per 500
  await assertNewestFirst(ids);
  return { ids: ids.slice(-oldest), truncated: false };
}

/** Human note about how a limiter shaped the result, shared by every report. */
export function describeLimit({ latest, oldest, truncated, max }, count) {
  const n = latest ?? oldest;
  if (n !== undefined) {
    const flag = latest ? 'latest' : 'oldest';
    return count < n
      ? ` (all ${count} matches, fewer than --${flag} ${n})`
      : ` (the ${flag} ${n} only${latest ? ', newest first' : ''})`;
  }
  return truncated ? ` (more exist beyond --max ${max})` : '';
}

const quoteIfNeeded = (value) => (/\s/.test(value) && !value.startsWith('"') ? `"${value}"` : value);
const anyOf = (operator, values) => {
  const terms = values.map((v) => `${operator}:${quoteIfNeeded(v)}`);
  return terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0];
};

async function applyPreset(values) {
  if (!values.preset) return values;
  const presets = JSON.parse(await readFile(PRESETS_FILE, 'utf8'));
  const preset = presets[values.preset];
  if (!preset) throw new Error(`Unknown preset "${values.preset}". Available: ${Object.keys(presets).join(', ')}`);
  return {
    ...values,
    from: [...(preset.from ?? []), ...(values.from ?? [])],
    label: [...(preset.label ?? []), ...(values.label ?? [])],
    category: values.category ?? preset.category,
    'older-than': values['older-than'] ?? preset.older_than,
    'newer-than': values['newer-than'] ?? preset.newer_than,
    query: [preset.query, values.query].filter(Boolean).join(' ') || undefined,
  };
}

/**
 * Build a Gmail search query from CLI values. `base` terms are always added but do not
 * count as criteria, so a bare run can never match the whole mailbox.
 */
export async function buildQuery(rawValues, base = []) {
  const v = await applyPreset(rawValues);
  const parts = [];
  if (v.from?.length) parts.push(anyOf('from', v.from));
  if (v.label?.length) parts.push(anyOf('label', v.label));
  if (v.category) parts.push(`category:${v.category}`);
  if (v['older-than']) parts.push(`older_than:${v['older-than']}`);
  if (v['newer-than']) parts.push(`newer_than:${v['newer-than']}`);
  if (v.query) parts.push(v.query);
  return { q: [...parts, ...base].join(' '), hasCriteria: parts.length > 0 };
}

// ---------------------------------------------------------------- reporting

const address = (from) => (from.match(/<([^>]+)>/)?.[1] ?? from).toLowerCase();
const shortDate = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10);
};

export function printReport(summaries, { truncated, max, latest, oldest, list }) {
  console.log(`Matched ${summaries.length} email(s)${describeLimit({ latest, oldest, truncated, max }, summaries.length)}`);
  const bySender = new Map();
  for (const s of summaries) {
    const key = address(s.from);
    bySender.set(key, { name: s.from, count: (bySender.get(key)?.count ?? 0) + 1 });
  }
  console.log('\nBy sender:');
  for (const { name, count } of [...bySender.values()].sort((a, b) => b.count - a.count)) {
    console.log(`  ${String(count).padStart(4)}  ${name}`);
  }
  if (list) {
    console.log('\nMessages:');
    for (const s of summaries) console.log(`  ${s.id}  ${shortDate(s.date)}  ${address(s.from)}  ${s.subject}`);
  }
}

export function run(main) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
