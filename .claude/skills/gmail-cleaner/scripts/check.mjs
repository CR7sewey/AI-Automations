#!/usr/bin/env node
// Verifies credentials and API access. Run this first; it changes nothing.
import { api, grantedScopes, run } from './lib/gmail.mjs';

run(async () => {
  const profile = await api('/profile');
  const scopes = await grantedScopes();
  console.log(`Authenticated as ${profile.emailAddress}`);
  console.log(`Mailbox: ${profile.messagesTotal} messages, ${profile.threadsTotal} threads`);
  console.log(`Scopes: ${scopes.map((s) => s.split('/').pop()).join(', ')}`);
  for (const needed of ['gmail.modify', 'gmail.settings.basic']) {
    if (!scopes.some((s) => s.endsWith(needed))) console.log(`WARNING: scope ${needed} is missing`);
  }
});
