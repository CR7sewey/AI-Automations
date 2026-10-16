# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A home for personal automations. Today it contains one: the `gmail-cleaner` project skill in `.claude/skills/gmail-cleaner/`, which cleans a Gmail mailbox by calling the Gmail REST API directly. All real code lives there. `SKILL.md` is the user-facing spec (rules, workflow, flag tables); read it before changing behavior, and keep it in sync with the scripts.

## Commands

There is no `package.json`, build, linter or test suite. The scripts are dependency-free ES modules for Node 18+ (Node 24 is installed) and use only built-ins (`fetch`, `node:util` `parseArgs`). Run them from the repo root:

```bash
node .claude/skills/gmail-cleaner/scripts/check.mjs                 # verify auth, read-only
node .claude/skills/gmail-cleaner/scripts/search.mjs --from X --list
node .claude/skills/gmail-cleaner/scripts/trash.mjs  --from X --newer-than 3m          # dry run
node .claude/skills/gmail-cleaner/scripts/trash.mjs  --from X --newer-than 3m --apply
node .claude/skills/gmail-cleaner/scripts/restore.mjs --from X --latest 3 --apply
node .claude/skills/gmail-cleaner/scripts/filters.mjs list|create|delete
```

Every script takes `--help`. Tests use the built-in runner and never contact Gmail (they stub `fetch` and point `GMAIL_CLEANER_DIR` at a temp dir):

```bash
node --test ".claude/skills/gmail-cleaner/tests/*.test.mjs"                  # all suites, ~10 s
node --test ".claude/skills/gmail-cleaner/tests/api.test.mjs"                # one file
node --test --test-name-pattern="refresh" ".claude/skills/gmail-cleaner/tests/*.test.mjs"   # by name
```

Quote the glob; passing the directory fails on Node 24. Beyond tests, verify changes with read-only commands or dry runs against the real mailbox. Shared fakes are in `tests/support/`.

In the Bash tool on this machine `npx` is not on the PATH (exit 127); call `node` directly. Large runs (thousands of emails) exceed the foreground timeout: use `run_in_background`.

## Architecture

- `scripts/lib/gmail.mjs` is the shared core; the five scripts are thin CLIs over it. It holds OAuth token handling, the REST client, query building, id selection and report printing.
- **Credentials are outside the repo**: `~/.gmail-mcp/gcp-oauth.keys.json` (OAuth client) and `credentials.json` (token), override with `GMAIL_CLEANER_DIR`. They were created by the Gmail MCP's one-time login, which the skill reuses; the client refreshes the access token itself and writes it back to the same `credentials.json`. Scopes are `gmail.modify` and `gmail.settings.basic`, which cannot permanently delete mail, so "delete" always means moving to Trash.
- **Request flow**: `buildQuery` turns CLI flags (or a `--preset` from `references/presets.json`) into one Gmail query. `base` terms such as `-is:starred` are appended but do not count as criteria, which is how a bare run (no criteria) is refused instead of matching the whole mailbox. `selectIds` then applies `--latest`/`--oldest`/`--max` and `getSummaries` fetches headers for the sender report.
- **Rate limiting is global**: `api()` spaces requests 200 ms apart (Gmail's quota page lists 6,000 units/min per user and 20 units per message fetch), and on 429/quota 403 pauses all callers together, honoring `Retry-After`, skipping retries for daily limits, and aborting after 15 minutes of cumulative pause. Writes (`batchModify`) go in sequential chunks of 500 because concurrent writes get rejected. A 401 refreshes the token once per request; network errors are retried only for idempotent calls.

## Conventions that matter

- Mutating scripts (`trash`, `restore`, `filters create/delete`) are **dry runs unless `--apply`**. Preserve this default and the preview-then-approve flow when adding features; never apply without the user approving the list they were just shown.
- `--latest N` and `--oldest N` are limiters, not criteria, and cannot be combined. `--max` (default 500) is a safety cap on how many emails a `trash`/`restore` run may act on, so `--oldest 2000` must be paired with `--max 2000`. They depend on Gmail listing newest first, which is undocumented; `selectIds` verifies the order and aborts if it is wrong. `--no-summary` (trash only) skips the per-email fetch and is for large runs after the user has already seen a sender breakdown.
- A `--query` value starting with `-` must be written `"--query=-(...)"` or `parseArgs` rejects it.
- Gmail's `from:` matches addresses, domains and display names as substrings. Marketing and transactional mail often differ only by subdomain, so scope filters narrowly (for example `info@news.thefork.pt`, not `thefork.pt`).
- Gmail stores a trash filter as `addLabelIds: [TRASH]` only; `filters.mjs` sends it that way so its duplicate check matches existing filters.
- Treat `~/.gmail-mcp/*` and `gcp-oauth.keys.json` as secrets: never print, commit or paste them. The latter is gitignored; `gcp-oauth.keys-mock.json` is an empty template. `.mcp.json` registers the Gmail MCP server, but the skill does not depend on it.

## Subagent workflow (`.claude/rules/workflow.md`, `.claude/agents/`)

Use `researcher` before building when outside facts are needed (Gmail API behavior, quotas, scopes); run `reviewer` on the diff after changes and fix its Critical issues and Warnings; run `qa` when `scripts/` logic changed. Verification never uses `--apply` against the real mailbox: use read-only commands, dry runs, or `node --test` with a stubbed `fetch` and a temp `GMAIL_CLEANER_DIR` (tests live in `.claude/skills/gmail-cleaner/tests/`).
