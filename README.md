# openai-audience-refresh

Monthly Railway service that keeps Buddy Punch's **customer exclusion audience** in
**OpenAI Ads Manager** fresh, so ChatGPT ads only reach non-customers — the OpenAI
counterpart of `customer-match-sync` (Google/Microsoft).

OpenAI's Advertiser API has **no audiences resource**, so this drives the Ads Manager
UI headlessly (Playwright) with a stored browser session — the same seeded session
`openai-receipt-grabber` uses (shared Supabase row `openai_grabber_session`).

## Flow (cron: daily, 5am CT)

A run first fingerprints the customer hash list; if it's byte-identical to the last fully successful run, it records `skipped_no_change` and does nothing further (no browser, no duplicate audience). Otherwise:


1. `rebuild_openai_audience_export()` RPC rebuilds the hash snapshot in the warehouse
   (view `openai_ads_exclusion_hashes` — paying-customer emails, `sha256(lower(trim(email)))`,
   NO gmail dot-stripping).
2. Pages the snapshot 1,000 rows/request (PostgREST max-rows cap) into a TXT.
3. Creates a dated audience — identifier type **Hashed Email (SHA-256)** (plain "Email"
   silently invalidates every hash).
4. Polls until it leaves Processing (Ready / Too small / failed).
5. For every campaign: Edit Campaign → Exclude custom audiences → tick the new audience,
   untick old family members → Save.
6. Archives the old audience(s) only if every campaign updated cleanly.
7. Posts a summary to #bot-status; errors and session-expiry alerts to #railway-logs.

## Endpoints

| Method · Path | Key | Purpose |
|---|---|---|
| GET `/` | — | health check |
| GET `/run` | `RUN_KEY` | trigger a refresh now (runs in background) |
| GET `/status` | `RUN_KEY` | last 10 ledger rows + running flag |
| GET `/seed` | `SEED_PASSWORD` | cookie-paste form |
| POST `/seed` | body `key` | save Cookie-Editor export / storageState (shared row) |

## Session

Stored in `openai_grabber_session` (row id=1) — **shared with openai-receipt-grabber**.
Seed once via either service's `/seed` (Cookie-Editor export from a logged-in
ads.openai.com tab). On expiry the run posts re-seed instructions to #railway-logs.

## Ledger

`openai_audience_refresh_runs` — one row per run: status (ok / partial / expired /
no_session / export_error / error), hash_count, matched_display, campaigns_updated,
old_archived, error.
