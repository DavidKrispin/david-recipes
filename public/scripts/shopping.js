// Shopping lists shared client-side module.
// Stored in localStorage under 'shopping-lists' AND synced to /api/shopping/sync (Azure Table Storage).
// CRDT-lite: per-item lastModified + soft deletes (deletedAt) so concurrent edits from multiple devices merge cleanly.
// Exposes window.ShoppingLists API + dispatches:
//   - 'shopping-lists:change'  (state changed)
//   - 'shopping-lists:sync'    (sync status changed) detail = { state: 'syncing'|'synced'|'offline'|'idle', error?: string }

(function () {
  const KEY = 'shopping-lists';
  const SYNC_URL = '/api/shopping/sync';
  const GET_URL = '/api/shopping';
  const SYNC_DEBOUNCE_MS = 500;
  const RETRY_BACKOFF_MS = 5000;
  const GC_DELETED_MS = 7 * 24 * 60 * 60 * 1000;
  const DEFAULT_STORE = { id: 'super', name: 'סופר', isDefault: true, items: [], lastModified: 0 };

  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function now() { return Date.now(); }

  // ---------- Local state ----------
  function migrateItem(it, storeFallbackTs) {
    if (!it || !it.id) return null;
    if (typeof it.lastModified !== 'number' || !it.lastModified) {
      it.lastModified = storeFallbackTs || 1;
    }
    return it;
  }

  function load() {
    let data;
    try {
      data = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch (_) { data = null; }
    if (!data || !Array.isArray(data.stores)) {
      data = { stores: [structuredClone(DEFAULT_STORE)], lastModified: 0 };
    }
    if (typeof data.lastModified !== 'number') data.lastModified = 0;
    if (!data.stores.some((s) => s.isDefault)) {
      data.stores.unshift(structuredClone(DEFAULT_STORE));
    }
    data.stores.forEach((s) => {
      if (typeof s.lastModified !== 'number') s.lastModified = 0;
      if (!Array.isArray(s.items)) s.items = [];
      s.items = s.items.map((it) => migrateItem(it, s.lastModified)).filter(Boolean);
    });
    return data;
  }

  function saveLocal(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
    window.dispatchEvent(new CustomEvent('shopping-lists:change', { detail: data }));
  }

  // Save and trigger cloud sync (debounced).
  function save(data, opts) {
    data.lastModified = now();
    saveLocal(data);
    if (!opts || !opts.skipSync) scheduleSync();
  }

  // Touch a store: bump its lastModified and the root.
  function touchStore(data, storeId) {
    const store = data.stores.find((s) => s.id === storeId);
    if (store) store.lastModified = now();
  }

  // Garbage-collect items deleted more than GC_DELETED_MS ago.
  function gc(data) {
    const cutoff = now() - GC_DELETED_MS;
    for (const s of data.stores) {
      s.items = s.items.filter((it) => !(it.deletedAt && it.deletedAt < cutoff));
    }
  }

  // ---------- CRDT-lite merge ----------
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
        const ea = itemEffectiveTs(existing);
        const eb = itemEffectiveTs(raw);
        if (eb > ea) map.set(id, raw);
        else if (eb === ea) {
          if (existing.deletedAt && !raw.deletedAt) map.set(id, raw);
        }
      }
    };
    ingest(aItems);
    ingest(bItems);
    const cutoff = now() - GC_DELETED_MS;
    const out = [];
    for (const it of map.values()) {
      if (it.deletedAt && it.deletedAt < cutoff) continue;
      out.push(it);
    }
    return out;
  }

  function mergeStore(a, b) {
    const aMod = a.lastModified || 0;
    const bMod = b.lastModified || 0;
    const newer = bMod > aMod ? b : a;
    return {
      id: newer.id,
      name: newer.name,
      isDefault: !!newer.isDefault,
      items: mergeItems(a.items || [], b.items || []),
      lastModified: Math.max(aMod, bMod),
    };
  }

  function mergeData(local, cloud) {
    if (!cloud || !Array.isArray(cloud.stores)) return local;
    const map = new Map();
    for (const s of cloud.stores) map.set(s.id, s);
    for (const s of local.stores) {
      const c = map.get(s.id);
      if (!c) map.set(s.id, s);
      else map.set(s.id, mergeStore(c, s));
    }
    const stores = Array.from(map.values());
    if (!stores.some((s) => s.isDefault)) stores.unshift(structuredClone(DEFAULT_STORE));
    return {
      stores,
      lastModified: Math.max(local.lastModified || 0, cloud.lastModified || 0),
    };
  }

  // ---------- Cloud sync ----------
  let syncState = 'idle';
  let syncTimer = null;
  let inFlight = false;
  let pendingAfter = false;
  let retryTimer = null;

  function emitSync(state, extra) {
    syncState = state;
    window.dispatchEvent(new CustomEvent('shopping-lists:sync', { detail: Object.assign({ state }, extra || {}) }));
  }

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, SYNC_DEBOUNCE_MS);
  }

  async function runSync() {
    syncTimer = null;
    if (inFlight) { pendingAfter = true; return; }
    if (!window.Auth || !window.Auth.isAuthenticated()) {
      emitSync('offline', { error: 'not-authenticated' });
      return;
    }
    inFlight = true;
    emitSync('syncing');
    const payload = load();
    try {
      // Use the merge-aware sync endpoint. Server merges item-by-item against cloud state.
      const res = await window.Auth.apiFetch(SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientData: payload }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const cloud = await res.json();
      // Even after a successful sync, merge again with current local in case the user kept editing.
      if (cloud && Array.isArray(cloud.stores)) {
        const current = load();
        const merged = mergeData(current, cloud);
        gc(merged);
        saveLocal(merged);
      }
      emitSync('synced');
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    } catch (err) {
      emitSync('offline', { error: err && err.message });
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(scheduleSync, RETRY_BACKOFF_MS);
    } finally {
      inFlight = false;
      if (pendingAfter) { pendingAfter = false; scheduleSync(); }
    }
  }

  // Pull on page load: GET cloud, merge with local item-by-item.
  async function pullFromCloud() {
    if (!window.Auth || !window.Auth.isAuthenticated()) {
      emitSync('offline', { error: 'not-authenticated' });
      window.dispatchEvent(new CustomEvent('shopping-lists:change', { detail: load() }));
      return;
    }
    emitSync('syncing');
    try {
      const res = await window.Auth.apiFetch(GET_URL, { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const cloud = await res.json();
      const local = load();
      const merged = mergeData(local, cloud);
      gc(merged);
      saveLocal(merged);
      // Push merged back so cloud absorbs any local-only changes.
      const cloudJson = JSON.stringify(cloud.stores || []);
      const mergedJson = JSON.stringify(merged.stores || []);
      if (cloudJson !== mergedJson) scheduleSync();
      emitSync('synced');
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    } catch (err) {
      emitSync('offline', { error: err && err.message });
      window.dispatchEvent(new CustomEvent('shopping-lists:change', { detail: load() }));
    }
  }

  // ---------- API surface ----------
  // Public getters return ONLY live items (deletedAt filtered out).
  function liveItems(items) {
    return (items || []).filter((it) => !it.deletedAt);
  }

  function getStores() {
    const data = load();
    return data.stores.map((s) => Object.assign({}, s, { items: liveItems(s.items) }));
  }

  function addStore(name) {
    const data = load();
    const trimmed = (name || '').trim();
    if (!trimmed) return null;
    const id = 'store-' + uuid();
    data.stores.push({ id, name: trimmed, isDefault: false, items: [], lastModified: now() });
    save(data);
    return id;
  }

  function deleteStore(storeId) {
    const data = load();
    const store = data.stores.find((s) => s.id === storeId);
    if (!store || store.isDefault) return false;
    data.stores = data.stores.filter((s) => s.id !== storeId);
    save(data);
    return true;
  }

  function renameStore(storeId, name) {
    const data = load();
    const store = data.stores.find((s) => s.id === storeId);
    const trimmed = (name || '').trim();
    if (!store || !trimmed) return false;
    store.name = trimmed;
    touchStore(data, storeId);
    save(data);
    return true;
  }

  function itemKey(name, unit) {
    return (name || '').trim().toLowerCase() + '||' + (unit || '').trim().toLowerCase();
  }

  function addItems(storeId, items, source) {
    const data = load();
    const store = data.stores.find((s) => s.id === storeId);
    if (!store) return false;
    const ts = new Date().toISOString();
    const ms = now();
    items.forEach((it) => {
      const key = itemKey(it.name, it.unit);
      // Match against LIVE items only (ignore soft-deleted for dedup).
      const existing = store.items.find((x) => !x.deletedAt && itemKey(x.name, x.unit) === key && !x.bought);
      if (existing && typeof it.qty === 'number' && typeof existing.qty === 'number') {
        existing.qty = +(existing.qty + it.qty).toFixed(3);
        existing.lastModified = ms;
      } else if (existing && it.qty != null && existing.qty == null) {
        existing.qty = it.qty;
        existing.lastModified = ms;
      } else {
        store.items.push({
          id: uuid(),
          name: (it.name || '').trim(),
          qty: it.qty == null ? null : it.qty,
          unit: it.unit || '',
          note: it.note || '',
          bought: false,
          source: source || it.source || 'manual',
          addedAt: ts,
          lastModified: ms,
        });
      }
    });
    touchStore(data, storeId);
    save(data);
    return true;
  }

  function addManualItem(storeId, freeText) {
    const text = (freeText || '').trim();
    if (!text) return false;
    return addItems(storeId, [{ name: text, qty: null, unit: '' }], 'manual');
  }

  function toggleItem(storeId, itemId) {
    const data = load();
    const store = data.stores.find((s) => s.id === storeId);
    if (!store) return false;
    const item = store.items.find((i) => i.id === itemId);
    if (!item || item.deletedAt) return false;
    item.bought = !item.bought;
    item.lastModified = now();
    touchStore(data, storeId);
    save(data);
    return true;
  }

  function removeItem(storeId, itemId) {
    const data = load();
    const store = data.stores.find((s) => s.id === storeId);
    if (!store) return false;
    const item = store.items.find((i) => i.id === itemId);
    if (!item) return false;
    // Soft delete: mark deletedAt, also bump lastModified so any tie-breakers see this as the latest event.
    const ms = now();
    item.deletedAt = ms;
    item.lastModified = ms;
    touchStore(data, storeId);
    save(data);
    return true;
  }

  function clearBought(storeId) {
    const data = load();
    const store = data.stores.find((s) => s.id === storeId);
    if (!store) return false;
    const ms = now();
    let any = false;
    for (const it of store.items) {
      if (!it.deletedAt && it.bought) {
        it.deletedAt = ms;
        it.lastModified = ms;
        any = true;
      }
    }
    if (!any) return false;
    touchStore(data, storeId);
    save(data);
    return true;
  }

  function clearAll(storeId) {
    const data = load();
    const store = data.stores.find((s) => s.id === storeId);
    if (!store) return false;
    const ms = now();
    let any = false;
    for (const it of store.items) {
      if (!it.deletedAt) {
        it.deletedAt = ms;
        it.lastModified = ms;
        any = true;
      }
    }
    if (!any) return false;
    touchStore(data, storeId);
    save(data);
    return true;
  }

  function totalUnchecked() {
    return load().stores.reduce(
      (sum, s) => sum + s.items.filter((i) => !i.deletedAt && !i.bought).length,
      0
    );
  }

  function syncNow() { scheduleSync(); }
  function getSyncState() { return syncState; }

  window.ShoppingLists = {
    KEY,
    load,
    save,
    getStores,
    addStore,
    deleteStore,
    renameStore,
    addItems,
    addManualItem,
    toggleItem,
    removeItem,
    clearBought,
    clearAll,
    totalUnchecked,
    uuid,
    // Cloud sync
    syncNow,
    pullFromCloud,
    getSyncState,
    // For tests / debugging
    _mergeData: mergeData,
    _mergeItems: mergeItems,
  };

  // Cross-tab sync via storage events
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      window.dispatchEvent(new CustomEvent('shopping-lists:change', { detail: load() }));
    }
  });

  // Re-sync when coming back online
  window.addEventListener('online', () => scheduleSync());

  // Initial pull from cloud (non-blocking) — only after auth is ready.
  if (typeof window !== 'undefined') {
    function tryInitialPull() {
      if (window.Auth && window.Auth.isAuthenticated()) {
        pullFromCloud();
      }
    }
    setTimeout(tryInitialPull, 0);
    // Re-pull when user signs in.
    window.addEventListener('auth:change', (e) => {
      if (e.detail) {
        pullFromCloud();
      } else {
        // Signed out — wipe local copy so next user starts fresh.
        try {
          localStorage.removeItem(KEY);
        } catch (_) {}
        window.dispatchEvent(new CustomEvent('shopping-lists:change', { detail: load() }));
      }
    });
  }
})();
