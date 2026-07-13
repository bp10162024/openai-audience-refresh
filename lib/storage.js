'use strict';

/**
 * lib/storage.js — Supabase persistence for openai-audience-refresh.
 *
 * Tables (in the Oracle warehouse project):
 *   openai_grabber_session        — SHARED with openai-receipt-grabber (row id=1,
 *                                   storage_state jsonb). One seed serves both services.
 *   openai_audience_refresh_runs  — run ledger for this service.
 *   tmp_openai_audience_export    — rebuilt by rpc rebuild_openai_audience_export()
 *                                   (rn + email_sha256), paged 1000 rows at a time
 *                                   because PostgREST max-rows caps every response.
 */

const { createClient } = require('@supabase/supabase-js');

let _client = null;

function client() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY env vars are required');
    }
    _client = createClient(url, key);
  }
  return _client;
}

/** Returns the stored Playwright storageState object, or null. */
async function getSession() {
  const { data, error } = await client()
    .from('openai_grabber_session')
    .select('storage_state')
    .eq('id', 1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // no row
    throw new Error(`getSession error: ${error.message}`);
  }
  return data ? data.storage_state : null;
}

/** Upserts the Playwright storageState into the SHARED row id=1. */
async function saveSession(storageState) {
  const { error } = await client()
    .from('openai_grabber_session')
    .upsert(
      { id: 1, storage_state: storageState, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
  if (error) throw new Error(`saveSession error: ${error.message}`);
  console.log('[storage] session saved (shared row)');
}

/**
 * Rebuilds the export snapshot server-side, then pages the full hash list.
 * @returns {Promise<string[]>} array of 64-hex sha256 strings
 */
async function fetchHashes() {
  const { data: cnt, error: rpcErr } = await client().rpc('rebuild_openai_audience_export');
  if (rpcErr) throw new Error(`rebuild_openai_audience_export rpc: ${rpcErr.message}`);
  console.log(`[storage] snapshot rebuilt: ${cnt} rows`);

  const all = [];
  const page = 1000; // PostgREST max-rows — do NOT raise; larger asks are silently truncated
  for (let from = 1; ; from += page) {
    const { data, error } = await client()
      .from('tmp_openai_audience_export')
      .select('email_sha256')
      .gte('rn', from)
      .lte('rn', from + page - 1)
      .order('rn');
    if (error) throw new Error(`fetchHashes page ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) all.push(r.email_sha256);
    if (data.length < page) break;
  }

  if (typeof cnt === 'number' && all.length !== cnt) {
    throw new Error(`fetchHashes assembly mismatch: got ${all.length} of ${cnt}`);
  }

  const bad = all.find((h) => !/^[0-9a-f]{64}$/.test(h));
  if (bad) throw new Error(`fetchHashes: non-sha256 value in export: ${String(bad).slice(0, 80)}`);

  return all;
}

/** Inserts a run ledger row. Never throws (ledger must not mask the real error). */
async function recordRun(row) {
  try {
    const { error } = await client().from('openai_audience_refresh_runs').insert(row);
    if (error) console.error('[storage] recordRun error:', error.message);
  } catch (err) {
    console.error('[storage] recordRun threw:', err.message);
  }
}

/** Last N ledger rows, newest first. */
async function recentRuns(limit = 10) {
  const { data, error } = await client()
    .from('openai_audience_refresh_runs')
    .select('*')
    .order('run_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`recentRuns error: ${error.message}`);
  return data || [];
}

/**
 * Fingerprint of the hash list from the most recent FULLY successful run
 * (status='ok'), or null. Used to skip a rebuild when the customer list
 * hasn't changed. Only 'ok' counts — a 'partial' run may have created an
 * audience it never finished attaching, so its fingerprint isn't safe to trust.
 */
async function lastOkFingerprint() {
  const { data, error } = await client()
    .from('openai_audience_refresh_runs')
    .select('hash_fingerprint')
    .eq('status', 'ok')
    .not('hash_fingerprint', 'is', null)
    .order('run_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`lastOkFingerprint error: ${error.message}`);
  return data && data[0] ? data[0].hash_fingerprint : null;
}

module.exports = { getSession, saveSession, fetchHashes, recordRun, recentRuns, lastOkFingerprint };
