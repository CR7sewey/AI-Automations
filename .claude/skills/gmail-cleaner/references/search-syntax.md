# Gmail search syntax cheat sheet

Used by `--query` and built automatically from the other flags.

| Operator | Example | Notes |
|---|---|---|
| `from:` | `from:news@shop.com`, `from:shop.com`, `from:"Display Name"` | Matches address, domain or display name |
| `to:` | `to:me` | |
| `subject:` | `subject:invoice` | |
| `label:` | `label:newsletters` | Use `-` for spaces: `label:my-label` |
| `category:` | `category:promotions` | `social`, `updates`, `forums`, `purchases` |
| `older_than:` / `newer_than:` | `older_than:30d`, `newer_than:3m` | Units `d`, `m`, `y` |
| `is:` | `is:starred`, `is:unread`, `is:important` | |
| `has:` | `has:attachment` | |
| `in:` | `in:trash`, `in:anywhere` | Trash and Spam are excluded unless asked for |
| `OR`, `-`, `( )` | `(from:a OR from:b) -is:starred` | `OR` must be uppercase |
| `"..."` | `"free spins"` | Exact phrase |

## Pitfalls

- `from:` is a substring-style match. `from:fork` would also match unrelated senders; use the full address or domain.
- Marketing and transactional mail often share a domain but not a subdomain (`news.` vs `email.`). Prefer the narrower address.
- Gmail's Promotions category mislabels some receipts and booking confirmations. Always read the sender summary.
- `older_than`/`newer_than` use relative days, months and years, not calendar dates. For a date range use `after:2026/07/01 before:2026/08/01`.

## Scopes used

| Scope | Allows |
|---|---|
| `gmail.modify` | Read mail, add/remove labels (incl. Trash). Cannot permanently delete. |
| `gmail.settings.basic` | Create, list and delete filters |
