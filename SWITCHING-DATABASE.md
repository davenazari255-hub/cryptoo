# If the database allowance runs out again

## What it looks like

Every `/api/*` route returns 500. The Vercel logs show nothing but 500s, which
looks exactly like a code bug — it is not. Prove which it is in one call:

```
curl -s -X POST https://cryptoo-beta.vercel.app/api/check-payment \
  -H 'Content-Type: application/json' \
  -d '{"action":"probe","secret":"<AUDIT_SECRET>"}'
```

It runs the real command shapes a sync poll issues, one at a time, and says
either `QUOTA EXHAUSTED` or `A COMMAND IS MALFORMED — this is a code bug`.
A malformed command and an exhausted allowance are indistinguishable from the
outside; this tells them apart.

## The three ways out

**1. Wait.** The allowance is monthly. Nothing else recovers the data, and
nothing in the app can work around it — an exhausted database refuses a plain
`GET`.

**2. Pay.** Upstash pay-as-you-go is $0.20 per 100K commands. At the app's
current cost (~5 commands per sync poll) that is well under a dollar a month.
Instant, and the data is untouched. This is the cheapest real fix.

**3. Point at a fresh free database.** Two environment variables, no code
change, works immediately — but a fresh database is empty, so every balance
reads as zero until the old data is brought across.

## Doing (3) safely

Create a new free Upstash database, then in Vercel change:

```
UPSTASH_REDIS_REST_URL     → the new database's URL
UPSTASH_REDIS_REST_TOKEN   → the new database's token
```

Redeploy. The app works again, empty.

Keep the old credentials. When the old allowance resets, bring the data over:

```
SRC_URL=<old url>  SRC_TOKEN=<old token> \
DST_URL=<new url>  DST_TOKEN=<new token> \
node scripts/redis-copy.js --dry-run
```

Check what it reports, then run it again without `--dry-run`.

By default it **skips keys that already exist** in the new database, so
anything a user changed in the meantime is preserved. Use `--overwrite` only if
you want the old data to win outright.

The script copies strings, sets, lists, hashes and sorted sets, preserves list
order and TTLs, resumes cleanly if interrupted, and stops loudly rather than
reporting a success it did not achieve. `test_copy.js` runs it against two fake
Upstash servers and covers all of that.

## Keeping it from happening again

The cost is a tested property, not a hope. `test_cost.js` runs the real
handlers against a counting fake Redis and fails if a sync poll costs more than
it should, if a second poller appears, if a background timer keeps running
while the app is hidden, or if the monthly projection stops fitting the free
tier.

Current numbers: 5 commands per poll, one poller, nothing at all while
backgrounded. That is roughly 70x cheaper per user-hour than the version that
exhausted the allowance.
