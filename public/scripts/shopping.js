// Shopping lists shared client-side module.
// Stored in localStorage under 'shopping-lists' AND synced to /api/shopping (Azure Table Storage).
// Exposes window.ShoppingLists API + dispatches:
//   - 'shopping-lists:change'  (state changed)
//   - 'shopping-lists:sync'    (sync status changed) detail = { state: 'syncing'|'synced'|'offline'|'idle', error?: string }

(function () {
  const KEY = 'shopping-lists';
  const API_URL = '/api/shopping';
  const SYNC_DEBOUNCE_MS = 500;
  const RETRY_BACKOFF_MS = 5000;
  const DEFAULT_STORE = { id: 'super', name: 'סופר', isDefault: true, items: [], lastModified: 0 };

  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function now() { return Date.now(); }

  // ---------- Local state ----------
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
    data.stores.forEach((s) => { if (typeof s.lastModified !== 'number') s.lastModified = 0; });
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
      const res = await window.Auth.apiFetch(API_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const cloud = await res.json();
      // Cloud is authoritative after a PUT. Only overwrite local if no further local changes happened in the meantime.
      if (!pendingAfter && cloud && Array.isArray(cloud.stores)) {
        const local = load();
        if ((cloud.lastModified || 0) >= (local.lastModified || 0)) {
          saveLocal(cloud);
        }
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

  // Pull on page load: GET cloud, merge with local using last-write-wins per store.
  async function pullFromCloud() {
    if (!window.Auth || !window.Auth.isAuthenticated()) {
      emitSync('offline', { error: 'not-authenticated' });
      window.dispatchEvent(new CustomEvent('shopping-lists:change', { detail: load() }));
      return;
    }
    emitSync('syncing');
    try {
      const res = await window.Auth.apiFetch(API_URL, { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const cloud = await res.json();
      const local = load();
      const merged = mergeData(local, cloud);
      // Always save merged result and notify UI
      saveLocal(merged);
      // Only push back if local had newer changes
      const cloudIsAhead = (cloud.lastModified || 0) >= (local.lastModified || 0)
        && JSON.stringify(merged) === JSON.stringify(cloud);
      if (!cloudIsAhead) {
        scheduleSync();
      }
      emitSync('synced');
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    } catch (err) {
      emitSync('offline', { error: err && err.message });
      // Still trigger a render with local data
      window.dispatchEvent(new CustomEvent('shopping-lists:change', { detail: load() }));
    }
  }

  function mergeData(local, cloud) {
    if (!cloud || !Array.isArray(cloud.stores)) return local;
    const map = new Map();
    for (const s of cloud.stores) map.set(s.id, s);
    for (const s of local.stores) {
      const c = map.get(s.id);
      if (!c) { map.set(s.id, s); continue; }
      const lMod = s.lastModified || 0;
      const cMod = c.lastModified || 0;
      if (lMod > cMod) map.set(s.id, s);
    }
    const stores = Array.from(map.values());
    if (!stores.some((s) => s.isDefault)) stores.unshift(structuredClone(DEFAULT_STORE));
    return {
      stores,
      lastModified: Math.max(local.lastModified || 0, cloud.lastModified || 0),
    };
  }

  // ---------- API surface ----------
  function getStores() { return load().stores; }

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
    items.forEach((it) => {
      const key = itemKey(it.name, it.unit);
      const existing = store.items.find((x) => itemKey(x.name, x.unit) === key && !x.bought);
      if (existing && typeof it.qty === 'number' && typeof existing.qty === 'number') {
        existing.qty = +(existing.qty + it.qty).toFixed(3);
      } else if (existing && it.qty != null && existing.qty == null) {
        existing.qty = it.qty;
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
    if (!item) return false;
    item.bought = !item.bought;
    touchStore(data, storeId);
    save(data);
    return true;
  }

  function removeItem(storeId, itemId) {
    const data = load();
    const store = data.stores.find((s) => s.id === storeId);
    if (!store) return false;
    store.items = store.items.filter((i) => i.id !== itemId);
    touchStore(data, storeId);
    save(data);
    return true;
  }

  function clearBought(storeId) {
    const data = load();
    const store = data.stores.find((s) => s.id === storeId);
    if (!store) return false;
    store.items = store.items.filter((i) => !i.bought);
    touchStore(data, storeId);
    save(data);
    return true;
  }

  function clearAll(storeId) {
    const data = load();
    const store = data.stores.find((s) => s.id === storeId);
    if (!store) return false;
    store.items = [];
    touchStore(data, storeId);
    save(data);
    return true;
  }

  function totalUnchecked() {
    return load().stores.reduce(
      (sum, s) => sum + s.items.filter((i) => !i.bought).length,
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
