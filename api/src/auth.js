// Google ID token verification + auth helper for Azure Functions handlers.
// Uses Google's tokeninfo endpoint for simple, dependency-free verification.
// (For high-volume APIs you'd cache JWKS and verify locally; here volume is tiny.)

const { resolveUserOnLogin } = require('./storage');

const ALLOWED_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '292463941706-dp8bjcfkbdal8kuvma252nci750f7osv.apps.googleusercontent.com';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo?id_token=';

// Tiny in-memory cache keyed by token → { exp, payload }
const _cache = new Map();
const CACHE_MAX = 200;

function cacheGet(tok) {
  const e = _cache.get(tok);
  if (!e) return null;
  if (e.exp * 1000 < Date.now() + 30_000) { _cache.delete(tok); return null; }
  return e.payload;
}
function cacheSet(tok, payload) {
  _cache.set(tok, { exp: payload.exp, payload });
  if (_cache.size > CACHE_MAX) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }
}

async function verifyIdToken(token) {
  if (!token) throw new Error('missing token');
  const cached = cacheGet(token);
  if (cached) return cached;
  const res = await fetch(TOKENINFO_URL + encodeURIComponent(token));
  if (!res.ok) throw new Error('invalid token (' + res.status + ')');
  const payload = await res.json();
  if (payload.aud !== ALLOWED_CLIENT_ID) throw new Error('aud mismatch');
  if (!payload.email) throw new Error('no email');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw new Error('email not verified');
  if (Number(payload.exp) * 1000 <= Date.now()) throw new Error('token expired');
  // Issuer check
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new Error('iss mismatch');
  }
  cacheSet(token, payload);
  return payload;
}

function extractToken(req) {
  // SWA strips/replaces Authorization on /api/*, so we use custom headers.
  // X-Auth-Token: <google id token>
  // X-Local-Sync: <secret>:<email>  (for the local sync script)
  const get = (name) => req.headers.get ? (req.headers.get(name) || req.headers.get(name.toLowerCase())) : (req.headers[name] || req.headers[name.toLowerCase()]);
  const xLocal = get('X-Local-Sync');
  if (xLocal) return 'local:' + xLocal;
  const xAuth = get('X-Auth-Token');
  if (xAuth) return xAuth.trim();
  const h = get('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// Returns { user, payload } or throws Response-like error.
async function authenticate(req) {
  const token = extractToken(req);
  if (!token) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }

  // Local sync shared-secret bypass (used by scripts/sync-from-cloud.cjs).
  // Format: "local:<secret>:<email>".
  if (token.startsWith('local:')) {
    const expected = process.env.LOCAL_SYNC_TOKEN;
    if (!expected) { const e = new Error('local sync disabled'); e.status = 401; throw e; }
    const [, secret, email] = token.split(':');
    if (!secret || !email || secret !== expected) {
      const e = new Error('invalid local token'); e.status = 401; throw e;
    }
    const user = await resolveUserOnLogin({ email, name: '', picture: '' });
    return { user, payload: { email, local: true } };
  }

  let payload;
  try {
    payload = await verifyIdToken(token);
  } catch (e) {
    const err = new Error('invalid token: ' + (e.message || e));
    err.status = 401;
    throw err;
  }
  const user = await resolveUserOnLogin({
    email: payload.email,
    name: payload.name || payload.given_name || '',
    picture: payload.picture || '',
  });
  return { user, payload };
}

function jsonResp(obj, status = 200) {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}

function cors(resp) {
  resp.headers = Object.assign({}, resp.headers, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,PATCH,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-Token, X-Local-Sync',
    'Access-Control-Max-Age': '600',
  });
  return resp;
}

function unauthorizedResp(msg) {
  return cors(jsonResp({ error: msg || 'unauthorized' }, 401));
}

async function readJson(req) {
  try {
    const text = await req.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (_) { return null; }
}

module.exports = { authenticate, jsonResp, cors, unauthorizedResp, readJson, ALLOWED_CLIENT_ID };
