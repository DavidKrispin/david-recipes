const { TableClient, odata } = require('@azure/data-tables');

const SHOPPING_TABLE = 'shoppinglists';
const USERS_TABLE = 'users';
const HOUSEHOLDS_TABLE = 'households';
const INVITES_TABLE = 'householdinvites';

const LEGACY_PARTITION = 'default';
const ROOT_ROW_KEY = '__root__';
const STORE_PREFIX = 'store__';

const USERS_PARTITION = 'users';
const HOUSEHOLDS_PARTITION = 'households';
const INVITES_PARTITION = 'invites';

const _clients = {};
function getClient(table) {
  if (_clients[table]) return _clients[table];
  const conn = process.env.TABLES_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error('TABLES_CONNECTION_STRING is not configured');
  _clients[table] = TableClient.fromConnectionString(conn, table, { allowInsecureConnection: false });
  return _clients[table];
}

const DEFAULT_STORE = { id: 'super', name: 'סופר', isDefault: true, items: [], lastModified: 0 };

function emptyData() {
  return { stores: [structuredClone(DEFAULT_STORE)], lastModified: 0 };
}

function emailKey(email) {
  return String(email || '').trim().toLowerCase();
}

async function ensureTable(client) {
  try { await client.createTable(); }
  catch (e) {
    if (e.statusCode === 409) return;
    if (e.code === 'TableAlreadyExists') return;
    throw e;
  }
}

// ---------- Users ----------
async function getUser(email) {
  const client = getClient(USERS_TABLE);
  await ensureTable(client);
  try {
    const e = await client.getEntity(USERS_PARTITION, emailKey(email));
    return safeJson(e.data);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function upsertUser(user) {
  if (!user || !user.email) throw new Error('user.email required');
  const client = getClient(USERS_TABLE);
  await ensureTable(client);
  const u = {
    email: emailKey(user.email),
    name: user.name || '',
    picture: user.picture || '',
    householdId: user.householdId || null,
    role: user.role || 'member',
    joinedAt: user.joinedAt || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  await client.upsertEntity(
    { partitionKey: USERS_PARTITION, rowKey: u.email, data: JSON.stringify(u) },
    'Replace'
  );
  return u;
}

async function listUsersByHousehold(householdId) {
  const client = getClient(USERS_TABLE);
  await ensureTable(client);
  const out = [];
  try {
    const iter = client.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${USERS_PARTITION}` },
    });
    for await (const e of iter) {
      const u = safeJson(e.data);
      if (u && u.householdId === householdId) out.push(u);
    }
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
  return out;
}

async function deleteUser(email) {
  const client = getClient(USERS_TABLE);
  try { await client.deleteEntity(USERS_PARTITION, emailKey(email)); }
  catch (err) { if (err.statusCode !== 404) throw err; }
}

// ---------- Households ----------
async function createHousehold({ name, ownerEmail }) {
  const client = getClient(HOUSEHOLDS_TABLE);
  await ensureTable(client);
  const id = 'h_' + (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)));
  const data = {
    id,
    name: name || 'משפחה',
    ownerEmail: emailKey(ownerEmail),
    createdAt: new Date().toISOString(),
  };
  await client.upsertEntity(
    { partitionKey: HOUSEHOLDS_PARTITION, rowKey: id, data: JSON.stringify(data) },
    'Replace'
  );
  return data;
}

async function getHousehold(id) {
  if (!id) return null;
  const client = getClient(HOUSEHOLDS_TABLE);
  await ensureTable(client);
  try {
    const e = await client.getEntity(HOUSEHOLDS_PARTITION, id);
    return safeJson(e.data);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

// ---------- Invites ----------
// Row key = email. Stores { email, householdId, invitedBy, invitedAt }
async function addInvite({ email, householdId, invitedBy }) {
  const client = getClient(INVITES_TABLE);
  await ensureTable(client);
  const data = {
    email: emailKey(email),
    householdId,
    invitedBy: emailKey(invitedBy),
    invitedAt: new Date().toISOString(),
  };
  await client.upsertEntity(
    { partitionKey: INVITES_PARTITION, rowKey: data.email, data: JSON.stringify(data) },
    'Replace'
  );
  return data;
}

async function getInvite(email) {
  const client = getClient(INVITES_TABLE);
  await ensureTable(client);
  try {
    const e = await client.getEntity(INVITES_PARTITION, emailKey(email));
    return safeJson(e.data);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function deleteInvite(email) {
  const client = getClient(INVITES_TABLE);
  try { await client.deleteEntity(INVITES_PARTITION, emailKey(email)); }
  catch (err) { if (err.statusCode !== 404) throw err; }
}

// ---------- Bootstrap / login ----------
// Resolve the user record for a verified Google identity. Creates user / household / honors invite as needed.
async function resolveUserOnLogin({ email, name, picture }) {
  const e = emailKey(email);
  let user = await getUser(e);
  if (user && user.householdId) {
    // Update name/picture if changed
    if (user.name !== name || user.picture !== picture) {
      user = await upsertUser({ ...user, name, picture });
    } else {
      // Just touch lastSeen
      user = await upsertUser(user);
    }
    return user;
  }

  // No user yet, or no household. Check invite first.
  const invite = await getInvite(e);
  if (invite && invite.householdId) {
    const hh = await getHousehold(invite.householdId);
    if (hh) {
      user = await upsertUser({
        email: e, name, picture,
        householdId: hh.id, role: 'member',
        joinedAt: new Date().toISOString(),
      });
      await deleteInvite(e);
      return user;
    }
  }

  // No invite: create a new household with this user as owner.
  const hh = await createHousehold({ name: (name ? `המשפחה של ${name}` : 'המשפחה שלי'), ownerEmail: e });
  user = await upsertUser({
    email: e, name, picture,
    householdId: hh.id, role: 'owner',
    joinedAt: new Date().toISOString(),
  });

  // One-time legacy migration: if there's data in the legacy "default" partition AND
  // this is the configured primary user, copy it into this household.
  if (e === emailKey(process.env.PRIMARY_USER_EMAIL || '')) {
    try { await migrateLegacyData(hh.id); } catch (_) { /* non-fatal */ }
  }
  return user;
}

async function migrateLegacyData(householdId) {
  const client = getClient(SHOPPING_TABLE);
  await ensureTable(client);
  // Read legacy partition
  let any = false;
  try {
    const iter = client.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${LEGACY_PARTITION}` },
    });
    for await (const e of iter) {
      any = true;
      // Copy to new partition
      await client.upsertEntity(
        { partitionKey: householdId, rowKey: e.rowKey, data: e.data },
        'Replace'
      );
    }
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
  return any;
}

// ---------- Shopping (household scoped) ----------
async function loadAll(householdId) {
  if (!householdId) throw new Error('householdId required');
  const client = getClient(SHOPPING_TABLE);
  const stores = [];
  let rootMeta = null;
  try {
    const iter = client.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${householdId}` },
    });
    for await (const e of iter) {
      if (e.rowKey === ROOT_ROW_KEY) {
        rootMeta = safeJson(e.data) || {};
        continue;
      }
      if (e.rowKey && e.rowKey.startsWith(STORE_PREFIX)) {
        const s = safeJson(e.data);
        if (s && s.id) stores.push(s);
      }
    }
  } catch (err) {
    if (err.statusCode === 404) {
      try { await client.createTable(); } catch (_) {}
      return emptyData();
    }
    throw err;
  }
  if (stores.length === 0 && !rootMeta) return emptyData();
  if (!stores.some((s) => s.isDefault)) stores.unshift(structuredClone(DEFAULT_STORE));
  // Sanitize: ensure every item has lastModified, and GC long-deleted items.
  const cutoff = Date.now() - GC_DELETED_MS;
  for (const s of stores) {
    const storeMod = Number(s.lastModified) || 0;
    s.items = (Array.isArray(s.items) ? s.items : [])
      .map((it) => sanitizeItem(it, storeMod))
      .filter((it) => it && !(it.deletedAt && Number(it.deletedAt) < cutoff));
  }
  stores.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  return {
    stores,
    lastModified: (rootMeta && rootMeta.lastModified) || stores.reduce((m, s) => Math.max(m, s.lastModified || 0), 0),
  };
}

// CRDT-lite item merge: pick newest by lastModified; soft-deletes win iff deletedAt > other side's lastModified.
// Garbage-collect deleted items older than GC_DELETED_MS.
const GC_DELETED_MS = 7 * 24 * 60 * 60 * 1000;

function itemEffectiveTs(item) {
  return Math.max(Number(item.lastModified) || 0, Number(item.deletedAt) || 0);
}

function mergeItems(aItems, bItems) {
  const map = new Map();
  const ingest = (items) => {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      if (!raw || !raw.id) continue;
      const id = String(raw.id);
      const existing = map.get(id);
      if (!existing) { map.set(id, raw); continue; }
      // Newer effective timestamp wins. A delete only wins if deletedAt > other side's lastModified.
      const ea = itemEffectiveTs(existing);
      const eb = itemEffectiveTs(raw);
      if (eb > ea) map.set(id, raw);
      else if (eb === ea) {
        // Tie: prefer the live one over a delete to avoid accidental loss; otherwise keep existing.
        if (existing.deletedAt && !raw.deletedAt) map.set(id, raw);
      }
    }
  };
  ingest(aItems);
  ingest(bItems);
  // GC long-deleted items.
  const cutoff = Date.now() - GC_DELETED_MS;
  const out = [];
  for (const it of map.values()) {
    if (it.deletedAt && Number(it.deletedAt) < cutoff) continue;
    out.push(it);
  }
  return out;
}

function mergeStore(a, b) {
  // Both stores have the same id. Use newer store metadata (name/isDefault) but always merge items.
  const aMod = Number(a.lastModified) || 0;
  const bMod = Number(b.lastModified) || 0;
  const newer = bMod > aMod ? b : a;
  return {
    id: newer.id,
    name: newer.name,
    isDefault: !!newer.isDefault,
    items: mergeItems(a.items || [], b.items || []),
    lastModified: Math.max(aMod, bMod),
  };
}

function mergeStores(serverStores, clientStores) {
  const map = new Map();
  for (const s of serverStores || []) map.set(s.id, s);
  for (const s of clientStores || []) {
    const existing = map.get(s.id);
    if (!existing) map.set(s.id, s);
    else map.set(s.id, mergeStore(existing, s));
  }
  return Array.from(map.values());
}

async function writeAll(householdId, data) {
  const client = getClient(SHOPPING_TABLE);
  await ensureTable(client);
  const now = Date.now();
  const lastModified = Number(data.lastModified) || now;
  const existingKeys = new Set();
  try {
    const iter = client.listEntities({
      queryOptions: { filter: odata`PartitionKey eq ${householdId}`, select: ['PartitionKey', 'RowKey'] },
    });
    for await (const e of iter) existingKeys.add(e.rowKey);
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
  const keepKeys = new Set([ROOT_ROW_KEY]);
  for (const store of data.stores) {
    const rowKey = STORE_PREFIX + sanitizeKey(store.id);
    keepKeys.add(rowKey);
    if (!store.lastModified) store.lastModified = now;
    await client.upsertEntity(
      { partitionKey: householdId, rowKey, data: JSON.stringify(store) },
      'Replace'
    );
  }
  await client.upsertEntity(
    { partitionKey: householdId, rowKey: ROOT_ROW_KEY, data: JSON.stringify({ lastModified }) },
    'Replace'
  );
  for (const k of existingKeys) {
    if (!keepKeys.has(k)) {
      try { await client.deleteEntity(householdId, k); } catch (_) {}
    }
  }
}

// PUT /api/shopping — now does an item-level merge instead of blind overwrite.
async function replaceAll(householdId, data) {
  if (!householdId) throw new Error('householdId required');
  const incoming = sanitizeData(data);
  const server = await loadAll(householdId);
  const mergedStores = mergeStores(server.stores, incoming.stores);
  const merged = { stores: mergedStores, lastModified: Date.now() };
  await writeAll(householdId, merged);
  return loadAll(householdId);
}

async function upsertStore(householdId, store) {
  if (!householdId) throw new Error('householdId required');
  if (!store || !store.id) throw new Error('store.id required');
  // Merge this single store into existing cloud state.
  const incoming = sanitizeData({ stores: [store] });
  const server = await loadAll(householdId);
  const mergedStores = mergeStores(server.stores, incoming.stores);
  const merged = { stores: mergedStores, lastModified: Date.now() };
  await writeAll(householdId, merged);
  return loadAll(householdId);
}

// POST /api/shopping/sync — explicit merge endpoint.
async function mergeSync(householdId, clientData) {
  return replaceAll(householdId, clientData);
}

function safeJson(s) { if (!s) return null; try { return JSON.parse(s); } catch (_) { return null; } }
function sanitizeKey(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200); }
function sanitizeItem(it, storeFallbackTs) {
  if (!it || typeof it !== 'object') return null;
  const id = it.id ? String(it.id) : null;
  if (!id) return null;
  // Migrate legacy items lacking timestamps: use store lastModified, or 1 (non-zero) so any new edit wins.
  const lastModified = Number(it.lastModified) || Number(storeFallbackTs) || 1;
  const out = {
    id,
    name: typeof it.name === 'string' ? it.name : '',
    qty: it.qty == null ? null : (typeof it.qty === 'number' ? it.qty : Number(it.qty) || null),
    unit: typeof it.unit === 'string' ? it.unit : '',
    note: typeof it.note === 'string' ? it.note : '',
    bought: !!it.bought,
    source: typeof it.source === 'string' ? it.source : 'manual',
    addedAt: it.addedAt || new Date().toISOString(),
    lastModified,
  };
  if (it.deletedAt) out.deletedAt = Number(it.deletedAt) || null;
  return out;
}
function sanitizeData(data) {
  const out = { stores: [], lastModified: data && data.lastModified ? Number(data.lastModified) : 0 };
  if (data && Array.isArray(data.stores)) {
    out.stores = data.stores
      .filter((s) => s && s.id && typeof s.name === 'string')
      .map((s) => {
        const storeMod = Number(s.lastModified) || 0;
        return {
          id: String(s.id),
          name: String(s.name),
          isDefault: !!s.isDefault,
          items: (Array.isArray(s.items) ? s.items : [])
            .map((it) => sanitizeItem(it, storeMod))
            .filter(Boolean),
          lastModified: storeMod,
        };
      });
  }
  return out;
}

module.exports = {
  // shopping
  loadAll, replaceAll, upsertStore, mergeSync,
  // identity
  getUser, upsertUser, listUsersByHousehold, deleteUser,
  createHousehold, getHousehold,
  addInvite, getInvite, deleteInvite,
  resolveUserOnLogin,
  emailKey,
};
