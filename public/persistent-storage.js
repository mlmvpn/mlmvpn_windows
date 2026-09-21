/**
 * PersistentStorage — جایگزین localStorage با ذخیره‌سازی فایلی سمت سرور
 * 
 * این ماژول یک کپی in-memory نگه می‌دارد و تمام نوشتن‌ها را به صورت
 * write-through به سرور ارسال می‌کند. هنگام load صفحه، ابتدا تمام 
 * داده‌ها از سرور bulk load می‌شوند.
 * 
 * API دقیقاً مشابه localStorage است تا تغییرات حداقل باشد.
 */

window.PersistentStorage = (function() {
    let _cache = {};
    let _ready = false;
    let _readyCallbacks = [];
    let _saveQueue = {};
    let _saveTimer = null;
    const SAVE_DEBOUNCE_MS = 200;

    // ==========================================
    // Initialization — Load synchronously from server-injected state
    // ==========================================
    function _init() {
        if (window.__INITIAL_STORAGE_STATE__) {
            _cache = window.__INITIAL_STORAGE_STATE__;
            console.log(`✅ [PersistentStorage] Loaded ${Object.keys(_cache).length} keys synchronously from server state`);
            
            // Migrate: if server is empty but localStorage has data, migrate it
            if (Object.keys(_cache).length === 0) {
                _migrateFromLocalStorage();
            } else {
                // Recovery: server has data but may be STALE (a save that didn't land before
                // the app closed). localStorage is written synchronously on every setItem, so
                // any key present there but missing on the server is a lost write — restore it.
                _recoverFromLocalStorage();
            }
        } else {
            console.warn('⚠️ [PersistentStorage] Server state not found, falling back to localStorage');
            _fallbackToLocalStorage();
        }
        
        _ready = true;
        _readyCallbacks.forEach(cb => cb());
        _readyCallbacks = [];
    }


    // Migrate existing localStorage data to server
    function _migrateFromLocalStorage() {
        const keysToMigrate = [
            'v2rayNodes', 'cf_accounts', 'ipscanner_history', 'ipscanner_archived_ips',
            'ipscanner_combo_groups', 'cf_base_configs', 'cf_saved_email', 'cf_saved_token',
            'latest-cloud-configs', 'latest-cloud-date', 'cf_migrated_v2',
            'sni_nodes', 'setting-speed-url', 'setting-ping-url', 'setting-udp-url',
            'scanner-theme', 'app_inputs', 'v2ray_nodes'
        ];
        
        let migrated = 0;
        const bulkItems = {};

        for (const key of keysToMigrate) {
            try {
                const val = localStorage.getItem(key);
                if (val !== null && val !== undefined) {
                    _cache[key] = val;
                    bulkItems[key] = val;
                    migrated++;
                }
            } catch (e) { /* ignore */ }
        }

        // Also migrate any other keys that look like app data
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && !bulkItems.hasOwnProperty(key)) {
                    const val = localStorage.getItem(key);
                    if (val !== null) {
                        _cache[key] = val;
                        bulkItems[key] = val;
                        migrated++;
                    }
                }
            }
        } catch (e) { /* ignore */ }

        if (migrated > 0) {
            console.log(`🔄 [PersistentStorage] Migrating ${migrated} keys from localStorage to server...`);
            fetch('/api/storage-bulk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: bulkItems })
            }).then(() => {
                console.log(`✅ [PersistentStorage] Migration complete!`);
            }).catch(e => {
                console.error('⚠️ [PersistentStorage] Migration failed:', e);
            });
        }
    }

    // Restore keys that exist in localStorage but are missing from the server cache
    // (i.e. a write that never persisted). removeItem clears both stores, so localStorage
    // never holds stale-deleted keys — merging missing keys is safe and recovers lost data.
    function _recoverFromLocalStorage() {
        try {
            const recovered = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && !_cache.hasOwnProperty(key)) {
                    const val = localStorage.getItem(key);
                    if (val !== null) { _cache[key] = val; recovered[key] = val; }
                }
            }
            const n = Object.keys(recovered).length;
            if (n > 0) {
                console.log(`🔄 [PersistentStorage] Recovered ${n} lost key(s) from localStorage`);
                fetch('/api/storage-bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: recovered }),
                    keepalive: true
                }).catch(() => {});
            }
        } catch (e) { /* recovery is best-effort */ }
    }

    function _fallbackToLocalStorage() {
        // If server is unreachable, use localStorage as fallback
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key) {
                    _cache[key] = localStorage.getItem(key);
                }
            }
        } catch (e) { /* ignore */ }
    }

    // ==========================================
    // Debounced save to server
    // ==========================================
    function _scheduleSave() {
        if (_saveTimer) return;
        _saveTimer = setTimeout(() => {
            _saveTimer = null;
            _flushSaveQueue();
        }, SAVE_DEBOUNCE_MS);
    }

    function _flushSaveQueue() {
        const items = { ..._saveQueue };
        _saveQueue = {};
        if (Object.keys(items).length === 0) return;

        const body = JSON.stringify({ items });
        // Prefer sendBeacon: it is designed to survive page/window unload, so the last
        // write (e.g. a newly added account) isn't cancelled when the app is closing.
        try {
            if (navigator && typeof navigator.sendBeacon === 'function') {
                const blob = new Blob([body], { type: 'application/json' });
                if (navigator.sendBeacon('/api/storage-bulk', blob)) return;
            }
        } catch (e) { /* fall through to fetch */ }

        fetch('/api/storage-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true
        }).catch(e => {
            console.error('⚠️ [PersistentStorage] Failed to save to server:', e);
        });
    }

    // ==========================================
    // Public API — matches localStorage interface
    // ==========================================
    function getItem(key) {
        return _cache.hasOwnProperty(key) ? _cache[key] : null;
    }

    function setItem(key, value) {
        const strValue = String(value);
        _cache[key] = strValue;
        _saveQueue[key] = strValue;
        _scheduleSave();

        // Also write to localStorage as backup
        try { localStorage.setItem(key, strValue); } catch(e) {}
    }

    function removeItem(key) {
        delete _cache[key];
        // Mark for deletion on server
        fetch('/api/storage/' + encodeURIComponent(key), { method: 'DELETE' }).catch(() => {});
        // Also remove from localStorage
        try { localStorage.removeItem(key); } catch(e) {}
    }

    function clear() {
        _cache = {};
        // Note: we don't clear server storage to prevent accidental data loss
    }

    function key(index) {
        const keys = Object.keys(_cache);
        return index < keys.length ? keys[index] : null;
    }

    function onReady(cb) {
        if (_ready) { cb(); return; }
        _readyCallbacks.push(cb);
    }

    // Start loading immediately
    _init();

    return {
        getItem,
        setItem,
        removeItem,
        clear,
        key,
        onReady,
        get length() { return Object.keys(_cache).length; },
        // Force flush any pending saves (call before page unload)
        flush: _flushSaveQueue
    };
})();

// Flush pending saves before page unload
window.addEventListener('beforeunload', () => {
    if (window.PersistentStorage && window.PersistentStorage.flush) {
        window.PersistentStorage.flush();
    }
});
