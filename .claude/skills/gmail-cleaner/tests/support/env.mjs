// Test support: creates a temp config dir with FAKE credentials and points the module at it.
// Import this BEFORE importing lib/gmail.mjs (paths are read at import time).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const dir = mkdtempSync(path.join(tmpdir(), 'gmail-cleaner-test-'));

writeFileSync(
  path.join(dir, 'gcp-oauth.keys.json'),
  JSON.stringify({ installed: { client_id: 'x', client_secret: 'y', token_uri: 'https://oauth.invalid/token' } }),
);
writeFileSync(
  path.join(dir, 'credentials.json'),
  JSON.stringify({
    access_token: 'fake-access',
    refresh_token: 'fake-refresh',
    scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic',
    expiry_date: 4_000_000_000_000,
  }),
);

process.env.GMAIL_CLEANER_DIR = dir;
