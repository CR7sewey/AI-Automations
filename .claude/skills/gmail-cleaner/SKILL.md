---
name: gmail-cleaner
description: Clean up a Gmail mailbox by sender, label, category or age. Previews matches, moves them to Trash only after approval, restores mistakes, and creates Gmail filters so unwanted senders never reach the inbox. Use when the user wants to delete, trash, clean up or declutter emails, unsubscribe-style bulk removal, or stop a sender from landing in the inbox.
---

# Gmail Cleaner

Calls the Gmail REST API directly through dependency-free Node scripts (Node 18+). It does not need the Gmail MCP server.

All scripts live in `scripts/` and are run from the project root, for example:
`node .claude/skills/gmail-cleaner/scripts/search.mjs --from buscojobs.com`

## Rules

1. **Preview before acting.** `trash.mjs` and `restore.mjs` are dry runs unless `--apply` is passed. Always run the dry run first and show the user the sender summary.
2. **Never pass `--apply` without explicit approval** of the list the user has just seen. Approval for one batch does not cover a different query.
3. **Trash only, never permanent delete.** Mail stays recoverable for 30 days (`restore.mjs`). The granted OAuth scope cannot permanently delete, and the scripts do not try.
4. **Flag risky matches** in the preview before asking: receipts and invoices, bank or insurance mail, booking or reservation confirmations, account or security notices, anything that looks like a real signup. Offer to keep them out with `--exclude-id`.
5. Starred mail is always kept unless `--include-starred` is given.
6. A bare run with no criteria is refused, so the whole mailbox can never match.

## Workflow

1. **Check access:** `node scripts/check.mjs`. Prints the account and scopes. If it fails, see Setup.
2. **Preview:** `node scripts/trash.mjs <criteria>` (or `search.mjs` for read-only exploration). Add `--list` to see every message.
3. **Review** the sender summary with the user. Call out risky matches (Rule 4). Get approval.
4. **Apply:** the same command plus `--apply`. Add `--exclude-id <id>` for each message to keep. The script reports how many remain matching afterwards.
5. **Offer filters** for senders that keep coming back, so cleanup is not repeated: `node scripts/filters.mjs create --from <sender> --apply`.
6. **Undo if needed:** `node scripts/restore.mjs <criteria> --apply`.

## Criteria

Shared by `search`, `trash` and `restore`; combined with AND.

| Flag | Meaning |
|---|---|
| `--from <x>` | Address, domain or display name. Repeat for OR. |
| `--label <x>` | Gmail label. Repeat for OR. |
| `--category <x>` | `promotions`, `social`, `updates`, `forums`, `purchases` |
| `--older-than <N[dwmy]>` | Received before that age, e.g. `30d`, `3m` |
| `--newer-than <N[dwmy]>` | Received within that age, e.g. `7d` |
| `--query <x>` | Raw Gmail search syntax, see `references/search-syntax.md` |
| `--preset <name>` | Named combination from `references/presets.json` |

### Limiting how many

| Flag | Meaning |
|---|---|
| `--latest N` | Keep only the **N newest** matches. Fewer or more existing matches is fine. Not a criterion: it still needs one of the flags above. |
| `--oldest N` | Keep only the **N oldest** matches. Same rules as `--latest`; the two cannot be combined. Listing every id to find the oldest is cheap, so it works on huge sets. |
| `--max N` | Safety cap on how many emails one `trash`/`restore` run may act on (default 500). A bigger match set is refused with `--apply`, and `--latest`/`--oldest` with a count above the cap is refused, so `--oldest 2000` needs `--max 2000` (or more) as an explicit confirmation. `search` is read-only and ignores the cap. |

`--latest`/`--oldest` rely on Gmail listing newest first, which the API docs do not promise; the scripts compare the first and last message dates and abort if the order is wrong.

### Large cleanups

- Gmail's quota page (checked 2026-10) lists 6,000 units/minute per user, with fetching one email's details costing 20, so about 5 emails/s. The client paces itself to that and pauses when Gmail pushes back (giving up after 15 minutes of total pauses), so a sender breakdown of 2,000 emails takes several minutes. Run those in the background.
- A sender breakdown sampled from the first 500-2000 matches can badly understate the real total. Count first with `trash.mjs ... --no-summary` (dry run, cheap) before agreeing to an approach, and tell the user the real number.
- `--no-summary` (`trash.mjs` only; `search` and `restore` reject it) skips the per-email detail fetch and prints just the count. Use it to count, or to apply on thousands of emails, **after** the user has seen a sender breakdown. Applying that many needs an explicit `--max` at least as large as the count.
- Slice a huge cleanup by age (`--older-than 60d --newer-than 1y`) rather than one giant batch; the part closest to what the user reviewed goes first.

### Excluding senders

Add negated terms with `--query`. A value starting with `-` must use the `=` form or Node's parser rejects it: `"--query=-(from:a.com OR from:b.com)"`. Preview what the exclusion keeps with the un-negated query first.

### Mapping requests to flags

- "Delete the last 3 emails from X" → `--from X --latest 3`
- "Delete the oldest 2000 old promotions" → `--category promotions --older-than 60d --oldest 2000`
- "Delete the last 3 months of X" → `--from X --newer-than 3m`
- "Clean up old promotions" → `--category promotions --older-than 30d`

"Last N emails" (a count) and "last N months" (a time window) are different; ask if the request is ambiguous. For `--latest` and `--oldest`, the preview lists the exact messages (add `--list`), so show it and confirm before `--apply`.

## Scripts

| Script | Purpose | Changes data? |
|---|---|---|
| `check.mjs` | Verify credentials, show account and scopes | No |
| `search.mjs` | Matches grouped by sender; `--list`, `--json`, `--max` | No |
| `trash.mjs` | Move matches to Trash; dry run unless `--apply` | With `--apply` |
| `restore.mjs` | Move matches from Trash back to the inbox | With `--apply` |
| `filters.mjs` | `list`, `create`, `delete` Gmail filters | `create`/`delete` with `--apply` |

Every script accepts `--help`. `search`, `trash` and `restore` all take `--latest N`, `--oldest N` and `--max N`; raise `--max` deliberately when a cleanup really should touch more than 500 emails.

## Filters

Filters only affect mail arriving after they are created; use `trash.mjs` for what is already there. Scope them narrowly. `--from` matches addresses, domains and display names, so:

- Use the marketing address, not the whole domain, when a sender also sends transactional mail (for example `info@news.thefork.pt`, not `thefork.pt`, so booking confirmations still arrive).
- Use the display name for digests from a shared sender address (for example `"Medium Daily Digest"` leaves Medium sign-in links alone).

`filters.mjs create` skips a filter that already exists identically.

## Setup

The scripts read an OAuth client and token from `~/.gmail-mcp/` (override with `GMAIL_CLEANER_DIR`):

- `gcp-oauth.keys.json`: the Google Cloud OAuth client ("Desktop app") JSON.
- `credentials.json`: access and refresh token, created by the one-time browser login. Scopes needed: `gmail.modify` and `gmail.settings.basic`.

They refresh the access token automatically and write it back to `credentials.json`. If the token is missing or revoked, redo the login once: `npx @gongrzhe/server-gmail-autoauth-mcp auth` (port 3000 must be free; keep the command running until the browser shows "Authentication successful").

Treat both files as secrets: never print them, commit them or paste them into chat.

## Troubleshooting

- `Cannot read ...credentials.json`: login not done yet; see Setup.
- `Token refresh failed`: token revoked or expired (test-mode Google apps expire refresh tokens after 7 days); redo the login.
- `rateLimitExceeded` / "too many concurrent requests": handled by automatic retry with backoff; no action needed.
- Search returns less than expected: Gmail excludes Trash and Spam by default, and starred mail is skipped by `trash.mjs`.
