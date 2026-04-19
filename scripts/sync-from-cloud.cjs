#!/usr/bin/env node
// scripts/sync-from-cloud.cjs
// Pull or push the cloud shopping lists JSON between the live site and the local workspace.
//
// Auth: uses a local shared-secret token (.local-sync-token) which the API accepts in the form
//   Authorization: Bearer local:<secret>:<email>
//
// Usage:
//   node scripts/sync-from-cloud.cjs           # pull (default)
//   node scripts/sync-from-cloud.cjs pull
//   node scripts/sync-from-cloud.cjs push      # PUT local file to cloud
//
// Output file: /home/openclaw/.openclaw/workspace/shopping-lists.json

const fs = require('fs');
const path = require('path');
const https = require('https');

const SITE_URL = process.env.SITE_URL || 'https://purple-smoke-02a2e3f03.7.azurestaticapps.net';
const API_PATH = '/api/shopping';
const OUT_FILE = process.env.SHOPPING_FILE || '/home/openclaw/.openclaw/workspace/shopping-lists.json';
const USER_EMAIL = process.env.SYNC_USER_EMAIL || 'guitar1@gmail.com';
const TOKEN_FILE = path.join(__dirname, '..', '.local-sync-token');

function getAuthHeaders() {
  let secret = process.env.LOCAL_SYNC_TOKEN;
  if (!secret) {
    try { secret = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); }
    catch (_) { throw new Error('No LOCAL_SYNC_TOKEN env var or .local-sync-token file'); }
  }
  return { 'X-Local-Sync': secret + ':' + USER_EMAIL };
}

function request(method, body) {
  const url = new URL(API_PATH, SITE_URL);
  const opts = {
    method,
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    headers: Object.assign({
      Accept: 'application/json',
    }, getAuthHeaders()),
  };
  let payload = null;
  if (body != null) {
    payload = Buffer.from(JSON.stringify(body), 'utf8');
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.headers['Content-Length'] = payload.length;
  }
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(text)); } catch (e) { resolve(text); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function pull() {
  const data = await request('GET');
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2) + '\n');
  const stores = (data.stores || []).length;
  const items = (data.stores || []).reduce((n, s) => n + (s.items || []).length, 0);
  console.log(`✓ Pulled ${stores} store(s), ${items} item(s) → ${OUT_FILE}`);
}

async function push() {
  if (!fs.existsSync(OUT_FILE)) throw new Error(`No local file at ${OUT_FILE}`);
  const data = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  const updated = await request('PUT', data);
  fs.writeFileSync(OUT_FILE, JSON.stringify(updated, null, 2) + '\n');
  console.log(`✓ Pushed local → cloud and refreshed ${OUT_FILE}`);
}

(async () => {
  const cmd = (process.argv[2] || 'pull').toLowerCase();
  try {
    if (cmd === 'pull') await pull();
    else if (cmd === 'push') await push();
    else { console.error('Usage: sync-from-cloud.cjs [pull|push]'); process.exit(2); }
  } catch (err) {
    console.error('✗', err.message);
    process.exit(1);
  }
})();
