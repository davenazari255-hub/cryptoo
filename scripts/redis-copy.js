#!/usr/bin/env node
/*
 * Copy one Upstash Redis database into another, over the REST API.
 *
 * Why this exists: the free tier's monthly command allowance ran out, and an
 * exhausted database refuses every billable command — including a plain GET.
 * No amount of application code can work around that. The two ways out are to
 * wait for the allowance to reset, or to point the app at a different database.
 *
 * Pointing at a fresh one is instant and free (it is two environment
 * variables), but a fresh database is empty, and this app keeps user balances
 * in it. That is only an acceptable trade if it is reversible — which is what
 * this script is for. When the old database can be read again, run this to
 * bring its contents across.
 *
 *   SRC_URL=https://old.upstash.io  SRC_TOKEN=...  \
 *   DST_URL=https://new.upstash.io  DST_TOKEN=...  \
 *   node scripts/redis-copy.js --dry-run
 *
 * Flags:
 *   --dry-run       read and report, write nothing            (always do this first)
 *   --only-missing  skip keys that already exist in DST       (default; protects
 *                   anything users changed while on the new database)
 *   --overwrite     replace DST keys from SRC                 (a true restore)
 *   --match <glob>  restrict to a key pattern, e.g. 'bal:*'
 *   --limit <n>     stop after n keys, for a careful first pass
 *
 * It copies strings, sets, lists, hashes and sorted sets, preserves TTLs, and
 * is safe to re-run: it is idempotent in --only-missing mode.
 */

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const DRY = has('--dry-run');
const OVERWRITE = has('--overwrite');
const MATCH = val('--match', '*');
const LIMIT = parseInt(val('--limit', '0'), 10) || Infinity;

const SRC = { url: process.env.SRC_URL, token: process.env.SRC_TOKEN };
const DST = { url: process.env.DST_URL, token: process.env.DST_TOKEN };

for (const [n, c] of [['SRC', SRC], ['DST', DST]]) {
  if (!c.url || !c.token) {
    console.error(`Missing ${n}_URL / ${n}_TOKEN`);
    process.exit(1);
  }
}
if (SRC.url === DST.url) { console.error('SRC and DST are the same database.'); process.exit(1); }

// One command. Throws on a real failure so an exhausted quota stops the run
// rather than silently copying nothing and reporting success.
async function cmd(conn, args) {
  const r = await fetch(conn.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { throw new Error(`bad response ${r.status}: ${t.slice(0, 160)}`); }
  if (j.error) throw new Error(String(j.error).slice(0, 200));
  return j.result;
}

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function main() {
  console.log(DRY ? '\nDRY RUN — nothing will be written\n' : '\nCOPYING\n');
  console.log(`  mode   : ${OVERWRITE ? 'overwrite DST' : 'only keys missing from DST'}`);
  console.log(`  match  : ${MATCH}\n`);

  // A quota-exhausted source fails here, immediately and loudly.
  try { await cmd(SRC, ['DBSIZE']); }
  catch (e) {
    console.error('Cannot read the source database:', e.message);
    console.error('\nIf that says "max requests limit exceeded", the source allowance is');
    console.error('still spent. Nothing can be copied until it resets.');
    process.exit(1);
  }

  const keys = [];
  let cursor = '0';
  do {
    const page = await cmd(SRC, ['SCAN', cursor, 'MATCH', MATCH, 'COUNT', 500]);
    cursor = String(page[0]);
    for (const k of page[1] || []) { if (keys.length < LIMIT) keys.push(String(k)); }
  } while (cursor !== '0' && keys.length < LIMIT);

  console.log(`  ${keys.length} keys to consider\n`);

  const stats = { string: 0, set: 0, list: 0, hash: 0, zset: 0, skipped: 0, failed: 0 };

  for (const key of keys) {
    try {
      if (!OVERWRITE) {
        const exists = await cmd(DST, ['EXISTS', key]);
        if (exists === 1) { stats.skipped++; continue; }
      }

      const type = await cmd(SRC, ['TYPE', key]);
      const ttl = await cmd(SRC, ['PTTL', key]);          // -1 none, -2 gone

      let write = null;
      if (type === 'string') {
        const v = await cmd(SRC, ['GET', key]);
        if (v === null) { stats.skipped++; continue; }
        write = ['SET', key, v];
        stats.string++;
      } else if (type === 'set') {
        const m = await cmd(SRC, ['SMEMBERS', key]);
        if (!m || !m.length) { stats.skipped++; continue; }
        write = ['SADD', key, ...m];
        stats.set++;
      } else if (type === 'list') {
        const m = await cmd(SRC, ['LRANGE', key, 0, -1]);
        if (!m || !m.length) { stats.skipped++; continue; }
        // RPUSH in order preserves the original head-to-tail ordering, which
        // matters: the ledger and notification feeds are newest-first.
        write = ['RPUSH', key, ...m];
        stats.list++;
      } else if (type === 'hash') {
        const flat = await cmd(SRC, ['HGETALL', key]);
        if (!flat || !flat.length) { stats.skipped++; continue; }
        write = ['HSET', key, ...flat];
        stats.hash++;
      } else if (type === 'zset') {
        const flat = await cmd(SRC, ['ZRANGE', key, 0, -1, 'WITHSCORES']);
        if (!flat || !flat.length) { stats.skipped++; continue; }
        const pairs = [];
        for (let i = 0; i < flat.length; i += 2) pairs.push(flat[i + 1], flat[i]); // score, member
        write = ['ZADD', key, ...pairs];
        stats.zset++;
      } else {
        stats.skipped++; continue;
      }

      if (!DRY) {
        if (OVERWRITE) await cmd(DST, ['DEL', key]);
        // Long lists and sets can exceed the request size cap, so write in
        // batches rather than one enormous command.
        if (write.length > 500) {
          const head = write.slice(0, 2);
          for (const part of chunk(write.slice(2), 400)) await cmd(DST, [...head, ...part]);
        } else {
          await cmd(DST, write);
        }
        if (typeof ttl === 'number' && ttl > 0) await cmd(DST, ['PEXPIRE', key, ttl]);
      }
    } catch (e) {
      stats.failed++;
      console.error(`  ! ${key}: ${e.message}`);
      if (/max requests limit/i.test(e.message)) {
        console.error('\nThe allowance ran out mid-copy. Re-run later: --only-missing');
        console.error('resumes where this stopped without duplicating anything.\n');
        break;
      }
    }
  }

  console.log('\n  strings %d  sets %d  lists %d  hashes %d  zsets %d',
    stats.string, stats.set, stats.list, stats.hash, stats.zset);
  console.log('  skipped %d  failed %d', stats.skipped, stats.failed);
  console.log(DRY ? '\nDry run only. Re-run without --dry-run to write.\n' : '\nDone.\n');
}

main().catch((e) => { console.error('\nFailed:', e.message); process.exit(1); });
