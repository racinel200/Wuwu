/*
 * Push data/characters.json and data/rotations.json up to Supabase (wuwa.docs).
 *
 *   SUPABASE_SERVICE_KEY=... node tools/sync-supabase.mjs
 *
 * The repo stays the source of truth; this makes the live page pick changes up
 * immediately instead of waiting on a GitHub Pages deploy. It is also how the table
 * gets seeded the first time.
 *
 * The service-role key bypasses row-level security on the WHOLE project, which holds
 * client PII in other schemas. Keep it in an environment variable for the length of one
 * command. Never paste it into a file, a commit, or a chat.
 *
 * To pull the other way — Supabase is ahead because a chat edited it directly — run
 * with --pull and the local files are overwritten from the table.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'data/source.json'), 'utf8')).supabase;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const PULL = process.argv.includes('--pull');
const DOCS = [['characters', 'data/characters.json'], ['rotations', 'data/rotations.json']];

const endpoint = `${cfg.url}/rest/v1/${cfg.table || 'docs'}`;
const headers = {
  apikey: KEY || cfg.key,
  Authorization: `Bearer ${KEY || cfg.key}`,
  'Content-Type': 'application/json',
  ...(cfg.schema && cfg.schema !== 'public'
    ? { 'Accept-Profile': cfg.schema, 'Content-Profile': cfg.schema } : {}),
};

async function pull() {
  const r = await fetch(`${endpoint}?select=key,doc,updated_at`, { headers });
  if (!r.ok) throw new Error(`read failed: HTTP ${r.status} ${await r.text()}`);
  const rows = await r.json();
  if (!rows.length) throw new Error('table is empty — run without --pull to seed it first');
  for (const [key, file] of DOCS) {
    const row = rows.find(x => x.key === key);
    if (!row) { console.log(`  ${key.padEnd(11)} not in the table, left alone`); continue; }
    writeFileSync(join(ROOT, file), JSON.stringify(row.doc, null, 2) + '\n');
    console.log(`  ${key.padEnd(11)} -> ${file}   (updated ${row.updated_at})`);
  }
}

async function push() {
  if (!KEY) {
    console.error('SUPABASE_SERVICE_KEY is not set.\n' +
      'Writes need the service-role key; the publishable key in source.json is read-only.\n' +
      '  SUPABASE_SERVICE_KEY=... node tools/sync-supabase.mjs');
    process.exit(1);
  }
  const body = DOCS.map(([key, file]) => ({
    key, doc: JSON.parse(readFileSync(join(ROOT, file), 'utf8')), updated_by: 'sync-supabase.mjs',
  }));
  const r = await fetch(`${endpoint}?on_conflict=key`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`write failed: HTTP ${r.status} ${await r.text()}`);
  for (const row of await r.json()) {
    const bytes = JSON.stringify(row.doc).length;
    console.log(`  ${row.key.padEnd(11)} pushed  ${bytes.toLocaleString('en-US')} bytes`);
  }
}

console.log(`${PULL ? 'Pulling from' : 'Pushing to'} ${cfg.url} (${cfg.schema}.${cfg.table})`);
await (PULL ? pull() : push());
console.log('done');
