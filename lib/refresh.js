'use strict';

/**
 * lib/refresh.js — core refresh flow for openai-audience-refresh.
 *
 * The OpenAI Ads Advertiser API has NO audiences resource (verified July 13 2026),
 * so this drives Ads Manager (ads.openai.com) headlessly with a stored session:
 *
 *   1. rebuild + fetch the customer hash list from the Oracle warehouse
 *   2. create a fresh dated audience (identifier type "Hashed Email (SHA-256)")
 *   3. poll until it leaves "Processing" (Ready / Too small / failed)
 *   4. swap it onto every campaign's "Exclude custom audiences" (add new, untick old)
 *   5. archive the old audience(s) — only after every campaign updated cleanly
 *
 * UI gotchas encoded here (learned July 13 2026, see openai-ads-bot skill):
 *   - Kebab menus / comboboxes / options ignore normal automation clicks;
 *     they need a full dispatched pointer sequence (dispatchClick).
 *   - Dialog submit buttons work via the element's __reactProps$ onClick (reactClick).
 *   - Text inputs drop characters under synthetic typing; set values via the
 *     native value setter + input event (setReactValue).
 *   - Identifier type MUST be "Hashed Email (SHA-256)" — uploading hashes as
 *     "Email" marks every row Invalid and the audience lands on "Too small".
 *   - NEVER use keyboard arrows in the row kebab: "Archive" (irreversible)
 *     sits directly under "Edit Campaign".
 */

const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { getSession, fetchHashes, recordRun, lastOkFingerprint } = require('./storage');
const { alert, status: statusPost, notifyReauth } = require('./notify');

const ACCT = process.env.OPENAI_ADS_ACCT || 'adacct_69fb4be99be4819e81fcc22805e0b6a8';
const BASE_NAME = process.env.AUDIENCE_BASE_NAME || 'Buddy Punch - Existing Customers (Exclude)';
const AUDIENCES_URL = `https://ads.openai.com/settings/audiences?act=${ACCT}`;
const CAMPAIGNS_URL = `https://ads.openai.com/manage/campaigns?act=${ACCT}`;
const POLL_MINUTES = parseInt(process.env.POLL_MINUTES || '5', 10);
const MAX_WAIT_MINUTES = parseInt(process.env.MAX_WAIT_MINUTES || '180', 10);

const SEED_URL = process.env.PUBLIC_URL
  ? `${process.env.PUBLIC_URL}/seed`
  : '(set PUBLIC_URL env for a clickable link) /seed on this service';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Low-level interaction helpers
// ---------------------------------------------------------------------------

/** Full pointer-sequence click dispatched in page context (Radix-safe). */
async function dispatchClick(handle) {
  await handle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true, cancelable: true, composed: true,
      clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
      button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    };
    el.dispatchEvent(new PointerEvent('pointermove', o));
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  });
}

/** Fire the element's React onClick prop directly (dialog submit buttons). */
async function reactClick(handle) {
  await handle.evaluate((el) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
    if (key && el[key] && typeof el[key].onClick === 'function') {
      el[key].onClick({
        preventDefault() {}, stopPropagation() {},
        target: el, currentTarget: el, type: 'click',
        nativeEvent: new MouseEvent('click'),
      });
    } else {
      el.click();
    }
  });
}

/** Set an input/textarea value through the native setter so React sees it. */
async function setReactValue(handle, value) {
  await handle.evaluate((el, val) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/** Find the combobox trigger that belongs to a field label (hop up ≤4 levels). */
async function triggerForLabel(page, labelText) {
  const handle = await page.evaluateHandle((label) => {
    const labels = [...document.querySelectorAll('label,div,span,p,h3,h4')]
      .filter((e) => e.textContent.trim() === label);
    const lab = labels[labels.length - 1];
    if (!lab) return null;
    let container = lab.parentElement;
    for (let hops = 0; hops < 4 && container; hops++) {
      const t = container.querySelector('[role="combobox"],button[aria-haspopup],[aria-expanded]');
      if (t) return t;
      container = container.parentElement;
    }
    return null;
  }, labelText);
  const el = handle.asElement();
  if (!el) throw new Error(`combobox trigger not found for label "${labelText}"`);
  return el;
}

/**
 * Navigate and wait for real page markers. 'networkidle' NEVER settles on
 * ads.openai.com (constant background traffic) and times out — verified
 * July 13 2026 on the receipt grabber. Wait for content or a login wall.
 */
async function gotoAndSettle(page, url, readyFn) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page
    .waitForFunction(readyFn, { timeout: 90000 })
    .catch(() => console.log(`[refresh] ready-marker wait timed out for ${url} — continuing`));
  await page.waitForTimeout(1500);
}

function audiencesReady() {
  const t = document.body ? document.body.innerText : '';
  return (
    [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Create audience')) ||
    [...document.querySelectorAll('tr,[role="row"]')].some((r) => r.textContent.includes('Buddy Punch')) ||
    /continue with google|sign up or login/i.test(t)
  );
}

function campaignsReady() {
  const t = document.body ? document.body.innerText : '';
  return (
    [...document.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') || '').match(/actions/i)) ||
    /continue with google|sign up or login/i.test(t)
  );
}

async function gotoAudiences(page) {
  await gotoAndSettle(page, AUDIENCES_URL, audiencesReady);
}

async function gotoCampaigns(page) {
  await gotoAndSettle(page, CAMPAIGNS_URL, campaignsReady);
}

/** Detect login/auth wall (session expired). */
async function isLoginPage(page) {
  if (/\/login|auth\.openai\.com|auth0/i.test(page.url())) return true;
  try {
    const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    if (/continue with google|sign up or login/i.test(bodyText)) return true;
  } catch (_) { /* conservative */ }
  return false;
}

/** Open the Actions kebab on the row containing rowText, click a menu item. */
async function rowMenuAction(page, rowText, menuItemText) {
  const kebab = await page.evaluateHandle((txt) => {
    const row = [...document.querySelectorAll('tr,[role="row"]')].find((r) => r.textContent.includes(txt));
    if (!row) return null;
    return [...row.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').match(/actions/i)) || null;
  }, rowText);
  const kebabEl = kebab.asElement();
  if (!kebabEl) throw new Error(`Actions button not found on row "${rowText}"`);
  await dispatchClick(kebabEl);
  await page.waitForTimeout(700);

  const item = await page.evaluateHandle((label) => {
    return [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent.trim() === label) || null;
  }, menuItemText);
  const itemEl = item.asElement();
  if (!itemEl) {
    const seen = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent.trim()));
    throw new Error(`menu item "${menuItemText}" not found (saw: ${seen.join(' | ') || 'none'})`);
  }
  await dispatchClick(itemEl);
  await page.waitForTimeout(900);
}

// ---------------------------------------------------------------------------
// Audience steps
// ---------------------------------------------------------------------------

async function createAudience(page, name, description, hashText) {
  await gotoAudiences(page);
  if (await isLoginPage(page)) throw Object.assign(new Error('session expired'), { code: 'expired' });

  // Header "Create audience" button (there is also one in the empty state; either works)
  const headerBtn = await page.evaluateHandle(() => {
    return [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim().replace(/^\+\s*/, '') === 'Create audience' && !b.closest('[role="dialog"]')
    ) || null;
  });
  const headerEl = headerBtn.asElement();
  if (!headerEl) throw new Error('Create audience button not found on Audiences page');
  await reactClick(headerEl);
  await page.waitForSelector('input', { timeout: 10000 });
  await page.waitForTimeout(500);

  // Name + description via native setters (typing drops characters in this UI)
  const nameInput = await page.evaluateHandle(() => {
    const inputs = [...document.querySelectorAll('input[type="text"],input:not([type])')].filter((i) => i.offsetParent);
    return inputs.find((i) => (i.placeholder || '').includes('Spring')) || inputs[0] || null;
  });
  const nameEl = nameInput.asElement();
  if (!nameEl) throw new Error('audience name input not found');
  await setReactValue(nameEl, name);

  const descHandle = await page.evaluateHandle(() => [...document.querySelectorAll('textarea')].find((t) => t.offsetParent) || null);
  const descEl = descHandle.asElement();
  if (descEl) await setReactValue(descEl, description);

  // Identifier type → Hashed Email (SHA-256). CRITICAL: plain "Email" invalidates every hash.
  const idTrigger = await triggerForLabel(page, 'Identifier type');
  await dispatchClick(idTrigger);
  await page.waitForTimeout(600);
  const hashedOpt = await page.evaluateHandle(() => {
    return [...document.querySelectorAll('[role="option"]')].find((m) => m.textContent.trim() === 'Hashed Email (SHA-256)') || null;
  });
  const hashedEl = hashedOpt.asElement();
  if (!hashedEl) throw new Error('identifier option "Hashed Email (SHA-256)" not found');
  await dispatchClick(hashedEl);
  await page.waitForTimeout(400);

  const idText = await idTrigger.evaluate((el) => el.textContent.trim());
  if (!/Hashed Email/i.test(idText)) throw new Error(`identifier type did not stick (shows "${idText}")`);

  // Attach the TXT
  await page.setInputFiles('input[type="file"]', {
    name: 'bp-existing-customers-sha256.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(hashText, 'utf-8'),
  });
  await page.waitForTimeout(800);

  // Submit
  const submit = await page.evaluateHandle(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Create audience');
    return btns.find((b) => b.closest('[role="dialog"]')) || btns[btns.length - 1] || null;
  });
  const submitEl = submit.asElement();
  if (!submitEl) throw new Error('Create audience submit button not found');
  await reactClick(submitEl);

  await page.waitForSelector('text=Audience upload complete', { timeout: 120000 });
  console.log(`[refresh] audience "${name}" uploaded`);
}

/**
 * Read {status, matched} for the audience row matching `name`, or null if the
 * row isn't rendered. Re-navigates and retries a few times before giving up,
 * so a single slow SPA render doesn't read an empty DOM.
 */
async function readAudienceRow(page, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await gotoAudiences(page);
    if (await isLoginPage(page)) throw Object.assign(new Error('session expired'), { code: 'expired' });
    // Wait specifically for our row (or any base-family row) to render.
    await page
      .waitForFunction(
        (nm) => [...document.querySelectorAll('tr,[role="row"]')].some((r) => r.textContent.includes(nm)),
        name,
        { timeout: 30000 }
      )
      .catch(() => {});
    const row = await page.evaluate((nm) => {
      const rows = [...document.querySelectorAll('tr,[role="row"]')].filter((r) => r.textContent.includes(nm));
      if (rows.length === 0) return null;
      const text = rows[0].innerText.replace(/\s+/g, ' ');
      const st = text.match(/\b(Processing|Ready|Too small|Failed|Error)\b/i);
      const matched = text.match(/\b(Ready|Processing|Too small|Failed|Error)\b\s+([\d.,KM]+-[\d.,KM]+|[\d.,KM]+|None)/i);
      return { status: st ? st[1] : 'Unknown', matched: matched ? matched[2] : '?', raw: text.slice(0, 300) };
    }, name);
    if (row) return row;
    await page.waitForTimeout(4000);
  }
  return null;
}

async function waitForReady(page, name) {
  const deadline = Date.now() + MAX_WAIT_MINUTES * 60 * 1000;
  // First check after 3 minutes, then every POLL_MINUTES
  await page.waitForTimeout(3 * 60 * 1000);
  let misses = 0;
  for (;;) {
    const row = await readAudienceRow(page, name);
    if (!row) {
      // Transient: a slow/empty render. Tolerate several in a row before failing,
      // since the audience genuinely exists (we just uploaded it).
      misses++;
      console.log(`[refresh] poll: row not found (miss ${misses}/6)`);
      if (misses >= 6) throw new Error(`audience row "${name}" not found on 6 consecutive polls`);
      if (Date.now() > deadline) throw new Error(`audience still not readable after ${MAX_WAIT_MINUTES} min`);
      await page.waitForTimeout(POLL_MINUTES * 60 * 1000);
      continue;
    }
    misses = 0;
    console.log(`[refresh] poll: status=${row.status} matched=${row.matched}`);
    if (/^Ready$/i.test(row.status)) return row;
    if (!/^Processing$/i.test(row.status)) {
      throw new Error(`audience processing failed: status "${row.status}" (${row.raw})`);
    }
    if (Date.now() > deadline) throw new Error(`audience still Processing after ${MAX_WAIT_MINUTES} min`);
    await page.waitForTimeout(POLL_MINUTES * 60 * 1000);
  }
}

// ---------------------------------------------------------------------------
// Campaign steps
// ---------------------------------------------------------------------------

async function listCampaignNames(page) {
  await gotoCampaigns(page);
  if (await isLoginPage(page)) throw Object.assign(new Error('session expired'), { code: 'expired' });
  await page.waitForTimeout(2000);
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr,[role="row"]')];
    const names = [];
    for (const r of rows) {
      const hasActions = [...r.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') || '').match(/actions/i));
      if (!hasActions) continue;
      const link = r.querySelector('a');
      const nm = (link ? link.textContent : '').trim();
      if (nm) names.push(nm);
    }
    return [...new Set(names)];
  });
}

/**
 * In the open Edit Campaign modal: make the Exclude list = { newName } among
 * BASE_NAME-family audiences. Non-BP audiences (if any ever exist) are untouched.
 */
async function setExclusion(page, newName) {
  const trigger = await triggerForLabel(page, 'Exclude custom audiences');
  await dispatchClick(trigger);
  await page.waitForTimeout(700);

  const desired = await page.evaluate(({ base, target }) => {
    const opts = [...document.querySelectorAll('[role="option"]')];
    const plans = [];
    for (const o of opts) {
      const text = o.textContent.trim();
      if (!text.includes(base)) continue;
      const isTarget = text.includes(target);
      const checked =
        o.getAttribute('aria-selected') === 'true' ||
        o.getAttribute('data-state') === 'checked' ||
        !!o.querySelector('svg');
      const disabled = o.getAttribute('aria-disabled') === 'true';
      plans.push({ text: text.slice(0, 120), isTarget, checked, disabled });
    }
    return plans;
  }, { base: BASE_NAME, target: newName });

  if (!desired.some((p) => p.isTarget)) {
    throw new Error(`new audience "${newName}" not present in Exclude options`);
  }
  if (desired.some((p) => p.isTarget && p.disabled)) {
    throw new Error(`new audience "${newName}" is disabled in Exclude options (not Ready?)`);
  }

  // Toggle: check target if unchecked; uncheck old family members if checked.
  for (const plan of desired) {
    const wantChecked = plan.isTarget;
    if (plan.checked === wantChecked) continue;
    const optHandle = await page.evaluateHandle((t) => {
      return [...document.querySelectorAll('[role="option"]')].find((m) => m.textContent.trim().slice(0, 120) === t) || null;
    }, plan.text);
    const optEl = optHandle.asElement();
    if (!optEl) throw new Error(`option vanished while toggling: ${plan.text}`);
    await dispatchClick(optEl);
    await page.waitForTimeout(500);
  }

  // Sanity: field must not read "Select..." (nothing selected)
  const fieldText = await trigger.evaluate((el) => el.textContent.trim());
  if (/^Select/i.test(fieldText)) {
    throw new Error('Exclude field still shows "Select..." after toggling — aborting before Save');
  }
}

async function updateCampaign(page, campaignName, newName) {
  await gotoCampaigns(page);
  await page.waitForTimeout(2000);
  await rowMenuAction(page, campaignName, 'Edit Campaign');
  await page.waitForSelector('text=Exclude custom audiences', { timeout: 15000 });

  await setExclusion(page, newName);

  const save = await page.evaluateHandle(() => {
    return [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save') || null;
  });
  const saveEl = save.asElement();
  if (!saveEl) throw new Error('Save button not found in Edit Campaign modal');
  await reactClick(saveEl);
  await page.waitForSelector('text=Updated campaign', { timeout: 30000 });
  console.log(`[refresh] campaign "${campaignName}" exclusion updated`);
}

/**
 * Archive every BASE_NAME-family audience except `keepName`. Iterative + re-reads
 * the list each pass (archiving reflows rows), tracks attempted names in a set so
 * an already-archived-but-still-listed row can't loop, and reads each row's actual
 * first-line name (no fragile regex reconstruction). Safety-capped.
 */
async function archiveOldAudiences(page, keepName) {
  let archived = 0;
  const attempted = new Set();
  for (let i = 0; i < 40; i++) {
    await gotoAudiences(page);
    await page.waitForTimeout(1200);
    const target = await page.evaluate(({ base, keep, done }) => {
      const rows = [...document.querySelectorAll('tr,[role="row"]')];
      for (const r of rows) {
        const line = (r.innerText || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
        if (line.startsWith(base) && line !== keep && !done.includes(line)) return line;
      }
      return null;
    }, { base: BASE_NAME, keep: keepName, done: [...attempted] });
    if (!target) break;
    attempted.add(target); // mark before acting so a failure can't re-loop it
    try {
      await rowMenuAction(page, target, 'Archive');
      archived++;
      console.log(`[refresh] archived old audience "${target}"`);
    } catch (err) {
      console.error(`[refresh] archive skipped for "${target}": ${err.message}`);
    }
  }
  return archived;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function runRefresh({ trigger = 'manual', force = false } = {}) {
  const started = Date.now();
  const nowIso = new Date().toISOString();
  const dateTag = nowIso.slice(0, 10);
  // Per-run unique suffix (date + UTC HHMM) so a same-day re-run — manual retry
  // or cron overlap — never collides with an existing audience of the same name.
  const newName = `${BASE_NAME} ${dateTag}-${nowIso.slice(11, 16).replace(':', '')}Z`;
  const description =
    `All current paying customer emails, SHA-256 hashed (trim+lowercase, hex). ` +
    `Mirrors the Google/Microsoft Customer Match exclusion list. Source: Oracle warehouse ` +
    `via openai-audience-refresh. Uploaded ${dateTag}. Auto-refreshed daily.`;

  const session = await getSession();
  if (!session) {
    await notifyReauth(SEED_URL);
    await recordRun({ trigger, audience_name: newName, status: 'no_session' });
    return { status: 'no_session' };
  }

  let hashes;
  try {
    hashes = await fetchHashes();
  } catch (err) {
    await alert(`:x: openai-audience-refresh — warehouse export failed: ${err.message}`);
    await recordRun({ trigger, audience_name: newName, status: 'export_error', error: String(err.message).slice(0, 500) });
    throw err;
  }
  const hashText = hashes.join('\n') + '\n';
  const fingerprint = crypto.createHash('sha256').update(hashText).digest('hex');
  console.log(`[refresh] ${hashes.length} hashes exported (fingerprint ${fingerprint.slice(0, 12)})`);

  // No-change skip: if the customer list is byte-identical to the last fully
  // successful run, the live audience already reflects it — don't create a
  // duplicate audience or open a browser. `force` (manual /run?force=1) bypasses.
  if (!force) {
    const prevFp = await lastOkFingerprint().catch((e) => {
      console.error('[refresh] lastOkFingerprint failed, proceeding with full run:', e.message);
      return null;
    });
    if (prevFp && prevFp === fingerprint) {
      console.log('[refresh] customer list unchanged since last ok run — skipping');
      await recordRun({ trigger, audience_name: newName, hash_count: hashes.length, status: 'skipped_no_change', hash_fingerprint: fingerprint });
      return { status: 'skipped_no_change', hashCount: hashes.length };
    }
  }

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({
      storageState: session,
      userAgent: USER_AGENT,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    // Session probe
    await gotoAudiences(page);
    if (await isLoginPage(page)) {
      await notifyReauth(SEED_URL);
      await recordRun({ trigger, audience_name: newName, hash_count: hashes.length, status: 'expired', hash_fingerprint: fingerprint });
      return { status: 'expired' };
    }

    await createAudience(page, newName, description, hashText);
    const readyRow = await waitForReady(page, newName);

    const campaigns = await listCampaignNames(page);
    console.log(`[refresh] campaigns found: ${campaigns.join(' | ') || '(none)'}`);
    const failures = [];
    let updated = 0;
    for (const c of campaigns) {
      try {
        await updateCampaign(page, c, newName);
        updated++;
      } catch (err) {
        failures.push(`${c}: ${err.message}`);
        console.error(`[refresh] campaign "${c}" failed: ${err.message}`);
      }
    }

    let archived = 0;
    if (failures.length === 0) {
      archived = await archiveOldAudiences(page, newName);
    }

    const elapsedMin = Math.round((Date.now() - started) / 60000);
    const ok = failures.length === 0;
    await recordRun({
      trigger,
      audience_name: newName,
      hash_count: hashes.length,
      status: ok ? 'ok' : 'partial',
      matched_display: readyRow.matched,
      campaigns_updated: updated,
      old_archived: archived,
      // Only stamp the fingerprint on a clean run — a 'partial' must re-run next
      // time, so leave its fingerprint null to prevent a bad no-change skip.
      hash_fingerprint: ok ? fingerprint : null,
      error: failures.length ? failures.join(' || ').slice(0, 900) : null,
    });

    const summary =
      `*openai-audience-refresh* — ${trigger}\n` +
      `audience: \`${newName}\` • ${hashes.length.toLocaleString()} hashes • Ready (matched ${readyRow.matched})\n` +
      `campaigns updated: ${updated}/${campaigns.length}` +
      (failures.length ? ` • :warning: failures: ${failures.join('; ').slice(0, 400)}` : '') +
      ` • old audiences archived: ${archived}\n` +
      `elapsed: ${elapsedMin}m`;
    await statusPost(summary);
    if (!ok) await alert(`:warning: openai-audience-refresh — partial run. ${failures.join('; ').slice(0, 600)} — old audience NOT archived; both exclusions may coexist (safe).`);

    return { status: ok ? 'ok' : 'partial', audience: newName, hashCount: hashes.length, matched: readyRow.matched, updated, archived, failures };
  } catch (err) {
    if (err && err.code === 'expired') {
      await notifyReauth(SEED_URL);
      await recordRun({ trigger, audience_name: newName, hash_count: hashes.length, status: 'expired', hash_fingerprint: fingerprint });
      return { status: 'expired' };
    }
    await alert(`:x: openai-audience-refresh — run failed: ${String(err.message).slice(0, 600)}`);
    await recordRun({ trigger, audience_name: newName, hash_count: hashes ? hashes.length : null, status: 'error', error: String(err.message).slice(0, 900) });
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { runRefresh };
