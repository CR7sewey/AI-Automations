# Workflow

Applies to any change to the automations in this repo (today: `.claude/skills/gmail-cleaner/`).

## Safety first

- Never run `--apply`, `filters.mjs create --apply` or `delete --apply` against the real mailbox as part of testing or verification. Verify with read-only commands (`check.mjs`, `search.mjs`) and dry runs, or with stubbed `fetch` in tests.
- Never print, read aloud or commit the contents of `~/.gmail-mcp/*` or `gcp-oauth.keys.json`.
- Behavior changes to the skill update `SKILL.md` in the same change: flags, defaults and rules must match the scripts.

## Where subagents fit

1. **Before building:** if the task needs outside facts (a Gmail API behavior, quota or scope rules, an OAuth detail), run `researcher` first.
2. **During building:** make the change, then check it by hand: `node <script> --help` still prints, and a dry run on a real query shows the expected sender summary.
3. **After the change works:** run `reviewer` on the diff and fix its Critical issues and Warnings.
4. **If you changed logic in `scripts/`:** run `qa` to add or update tests in `.claude/skills/gmail-cleaner/tests/`, and run them: `node --test ".claude/skills/gmail-cleaner/tests/*.test.mjs"`. Docs-only and preset-only changes skip `qa`.
5. **Only then** report the work as done, stating which dry runs and tests you actually ran.
