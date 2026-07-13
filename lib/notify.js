'use strict';

/**
 * lib/notify.js — Slack notifications for openai-audience-refresh.
 * Env vars:
 *   SLACK_BOT_TOKEN      — xoxb-... token with chat:write
 *   SLACK_ALERT_CHANNEL  — #railway-logs channel ID (errors, session expiry)
 *   SLACK_STATUS_CHANNEL — #bot-status channel ID (run summaries)
 */

const { WebClient } = require('@slack/web-api');

let _slack = null;

function slack() {
  if (!_slack) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error('SLACK_BOT_TOKEN env var is required');
    _slack = new WebClient(token);
  }
  return _slack;
}

async function post(channelEnv, text) {
  const channel = process.env[channelEnv];
  if (!channel) {
    console.error(`[notify] ${channelEnv} not set; message dropped: ${text.slice(0, 120)}`);
    return;
  }
  try {
    await slack().chat.postMessage({ channel, text });
  } catch (err) {
    console.error('[notify] Slack post failed:', err.message);
  }
}

/** Error/alert → #railway-logs */
async function alert(text) {
  await post('SLACK_ALERT_CHANNEL', text);
}

/** Run summary → #bot-status */
async function status(text) {
  await post('SLACK_STATUS_CHANNEL', text);
}

/** Session-expired alert with re-seed instructions. */
async function notifyReauth(seedUrl) {
  const text =
    `:warning: *openai-audience-refresh — OpenAI Ads session expired or missing*\n\n` +
    `The stored browser session for ads.openai.com is not valid, so the monthly ` +
    `customer-exclusion audience refresh cannot run. (This session is SHARED with ` +
    `openai-receipt-grabber — re-seeding once fixes both services.)\n\n` +
    `*How to fix:*\n` +
    `1. Install the *Cookie-Editor* browser extension.\n` +
    `2. Log in to <https://ads.openai.com|ads.openai.com>.\n` +
    `3. Open Cookie-Editor, click *Export* (copies JSON to clipboard).\n` +
    `4. Go to <${seedUrl}|${seedUrl}>, paste the JSON, and submit.\n\n` +
    `Then re-trigger the refresh via GET /run or wait for the next monthly cron.`;
  await alert(text);
}

module.exports = { alert, status, notifyReauth };
