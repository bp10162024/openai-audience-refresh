'use strict';

/**
 * index.js — openai-audience-refresh
 *
 * Express server + monthly cron that refreshes the Buddy Punch customer
 * exclusion audience in OpenAI Ads Manager (headless browser; no audiences API).
 *
 * Endpoints:
 *   GET  /               — health check
 *   GET  /run            — trigger a refresh now (?key=RUN_KEY)
 *   GET  /status         — last 10 ledger rows (?key=RUN_KEY)
 *   GET  /seed           — cookie-paste UI (?key=SEED_PASSWORD)
 *   POST /seed           — accept Cookie-Editor JSON or Playwright storageState
 *                          (writes the SHARED openai_grabber_session row —
 *                           also fixes openai-receipt-grabber)
 */

const express = require('express');
const cron = require('node-cron');
const { runRefresh, diagnoseAudiences } = require('./lib/refresh');
const { saveSession, recentRuns } = require('./lib/storage');

const PORT = process.env.PORT || 8080;
const RUN_KEY = process.env.RUN_KEY || '';
const SEED_PASSWORD = process.env.SEED_PASSWORD || '';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 5 * * *'; // daily, 5am CT
const CRON_TZ = process.env.CRON_TZ || 'America/Chicago';

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/', (_req, res) => res.type('text/plain').send('OK'));

function requireKey(envKey) {
  return (req, res, next) => {
    if (!envKey) return res.status(503).json({ ok: false, error: 'endpoint not configured' });
    const provided = req.query.key || (req.body && req.body.key);
    if (provided !== envKey) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  };
}

let running = false;

app.get('/run', requireKey(RUN_KEY), async (req, res) => {
  if (running) return res.status(409).json({ ok: false, error: 'a refresh is already in progress' });
  running = true;
  const force = req.query.force === '1' || req.query.force === 'true';
  // Refresh takes 15 min – 3 h (audience processing wait) — run in background.
  res.json({ ok: true, status: 'background', force, note: 'summary + errors post to #railway-logs' });
  try {
    await runRefresh({ trigger: 'manual', force });
  } catch (err) {
    console.error('[/run] error:', err.message);
  } finally {
    running = false;
  }
});

// Temporary read-only diagnostic for the "audience row not found" drift.
app.get('/diag', requireKey(RUN_KEY), async (_req, res) => {
  try {
    res.json({ ok: true, diag: await diagnoseAudiences() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, stack: (err.stack || '').slice(0, 900) });
  }
});

app.get('/status', requireKey(RUN_KEY), async (_req, res) => {
  try {
    res.json({ ok: true, running, runs: await recentRuns(10) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Seed endpoints (same pattern + same Supabase row as openai-receipt-grabber)
// ---------------------------------------------------------------------------

app.get('/seed', requireKey(SEED_PASSWORD), (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><title>Seed OpenAI Ads session</title>
<style>body{font-family:-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 16px}
textarea{width:100%;height:260px;font-family:monospace;font-size:12px}
button{padding:10px 18px;font-size:15px;margin-top:10px}</style></head><body>
<h2>Seed the OpenAI Ads browser session</h2>
<ol>
<li>In a tab logged into <a href="https://ads.openai.com" target="_blank">ads.openai.com</a>, open the <b>Cookie-Editor</b> extension.</li>
<li>Click <b>Export</b> (copies JSON to clipboard).</li>
<li>Paste below and submit. This updates the session shared with openai-receipt-grabber.</li>
</ol>
<textarea id="c" placeholder="Paste Cookie-Editor JSON export here"></textarea><br>
<button onclick="go()">Submit</button>
<pre id="out"></pre>
<script>
async function go(){
  const out=document.getElementById('out');
  let cookies;
  try{cookies=JSON.parse(document.getElementById('c').value);}catch(e){out.textContent='Invalid JSON: '+e.message;return;}
  const resp=await fetch(location.pathname+location.search,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:new URLSearchParams(location.search).get('key'),cookies})});
  out.textContent=await resp.text();
}
</script></body></html>`);
});

function mapSameSite(s) {
  if (!s) return 'Lax';
  const lower = s.toLowerCase();
  if (lower === 'no_restriction' || lower === 'none') return 'None';
  if (lower === 'strict') return 'Strict';
  return 'Lax';
}

function cookieEditorToStorageState(arr) {
  const OPENAI_DOMAINS = /openai\.com|ads\.openai\.com|auth\.openai\.com|chatgpt\.com/i;
  const cookies = arr
    .filter((c) => c.domain && OPENAI_DOMAINS.test(c.domain))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.expirationDate != null ? Math.floor(c.expirationDate) : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: mapSameSite(c.sameSite),
    }));
  return { cookies, origins: [] };
}

app.post('/seed', requireKey(SEED_PASSWORD), async (req, res) => {
  try {
    const { cookies } = req.body;
    if (!cookies) return res.status(400).json({ ok: false, error: 'missing cookies field' });

    let storageState;
    if (Array.isArray(cookies)) {
      storageState = cookieEditorToStorageState(cookies);
    } else if (typeof cookies === 'object' && Array.isArray(cookies.cookies)) {
      storageState = cookies;
    } else {
      return res.status(400).json({ ok: false, error: 'cookies must be a Cookie-Editor array or Playwright storageState' });
    }
    if (storageState.cookies.length === 0) {
      return res.status(400).json({ ok: false, error: 'no openai.com cookies found — export while on ads.openai.com' });
    }
    await saveSession(storageState);
    res.json({ ok: true, cookieCount: storageState.cookies.length, note: 'shared session updated (receipt-grabber too)' });
  } catch (err) {
    console.error('[/seed] error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Monthly cron
// ---------------------------------------------------------------------------

cron.schedule(
  CRON_SCHEDULE,
  async () => {
    if (running) return console.log('[cron] refresh already in progress, skipping');
    running = true;
    console.log(`[cron] starting scheduled refresh at ${new Date().toISOString()}`);
    try {
      await runRefresh({ trigger: 'cron' });
    } catch (err) {
      console.error('[cron] error:', err.message);
    } finally {
      running = false;
    }
  },
  { timezone: CRON_TZ }
);

app.listen(PORT, () => {
  console.log(`openai-audience-refresh running on PORT ${PORT}`);
  console.log(`cron: "${CRON_SCHEDULE}" (${CRON_TZ})`);
});
