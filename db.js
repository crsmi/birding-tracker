/* ==========================================================================
   db.js — IndexedDB Controller for eBird YoY Tracker
   ========================================================================== */

const DB_NAME = 'ebird-tracker-db';
const DB_VERSION = 1;

const STORES = {
  OBSERVATIONS: 'observations',
  TARGETS: 'targets',
  SETTINGS: 'settings',
};

let _dbInstance = null;

/**
 * Open (or create) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  if (_dbInstance) return Promise.resolve(_dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // --- observations store ---
      if (!db.objectStoreNames.contains(STORES.OBSERVATIONS)) {
        const obsStore = db.createObjectStore(STORES.OBSERVATIONS, { keyPath: 'id' });
        obsStore.createIndex('commonName', 'commonName', { unique: false });
        obsStore.createIndex('county', 'county', { unique: false });
        obsStore.createIndex('state', 'state', { unique: false });
        obsStore.createIndex('year', 'year', { unique: false });
        obsStore.createIndex('date', 'date', { unique: false });
        obsStore.createIndex('countySpecies', ['county', 'commonName'], { unique: false });
        obsStore.createIndex('stateCounty', ['state', 'county'], { unique: false });
      }

      // --- targets store ---
      if (!db.objectStoreNames.contains(STORES.TARGETS)) {
        db.createObjectStore(STORES.TARGETS, { keyPath: 'commonName' });
      }

      // --- settings store ---
      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      _dbInstance = event.target.result;
      resolve(_dbInstance);
    };

    request.onerror = (event) => {
      reject(new Error('IndexedDB error: ' + event.target.error));
    };
  });
}

/**
 * Generic helper: run a transaction and return a promise.
 */
function txPromise(storeName, mode, callback) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = callback(store, tx);
      tx.oncomplete = () => resolve(result._value !== undefined ? result._value : undefined);
      tx.onerror = () => reject(tx.error);
    });
  });
}

/* --------------------------------------------------------------------------
   Observations
   -------------------------------------------------------------------------- */

/**
 * Insert observations in bulk (batched puts).
 * @param {Array<Object>} records
 * @returns {Promise<void>}
 */
function putObservations(records) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.OBSERVATIONS, 'readwrite');
      const store = tx.objectStore(STORES.OBSERVATIONS);
      for (const rec of records) {
        store.put(rec);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

/**
 * Get all observations (optionally filtered by county/state).
 * @param {{ state?: string, county?: string }} [filter]
 * @returns {Promise<Array<Object>>}
 */
function getObservations(filter) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.OBSERVATIONS, 'readonly');
      const store = tx.objectStore(STORES.OBSERVATIONS);
      let request;

      if (filter && filter.state && filter.county) {
        const idx = store.index('stateCounty');
        request = idx.getAll([filter.state, filter.county]);
      } else if (filter && filter.county) {
        const idx = store.index('county');
        request = idx.getAll(filter.county);
      } else if (filter && filter.state) {
        const idx = store.index('state');
        request = idx.getAll(filter.state);
      } else {
        request = store.getAll();
      }

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Get distinct state/county combinations present in the database.
 * @returns {Promise<Array<{state: string, county: string}>>}
 */
function getDistinctRegions() {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.OBSERVATIONS, 'readonly');
      const store = tx.objectStore(STORES.OBSERVATIONS);
      const idx = store.index('stateCounty');
      const request = idx.openKeyCursor(null, 'nextunique');
      const regions = [];

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          regions.push({ state: cursor.key[0], county: cursor.key[1] });
          cursor.continue();
        } else {
          resolve(regions);
        }
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Count total observations.
 * @returns {Promise<number>}
 */
function countObservations() {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.OBSERVATIONS, 'readonly');
      const store = tx.objectStore(STORES.OBSERVATIONS);
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Clear all observations.
 * @returns {Promise<void>}
 */
function clearObservations() {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.OBSERVATIONS, 'readwrite');
      const store = tx.objectStore(STORES.OBSERVATIONS);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

/* --------------------------------------------------------------------------
   Targets
   -------------------------------------------------------------------------- */

/**
 * Get all targets.
 * @returns {Promise<Array<{commonName: string, isTarget: boolean, addedAt: string}>>}
 */
function getTargets() {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.TARGETS, 'readonly');
      const store = tx.objectStore(STORES.TARGETS);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Set or unset a target for a species.
 * @param {string} commonName
 * @param {boolean} isTarget
 * @returns {Promise<void>}
 */
function setTarget(commonName, isTarget) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.TARGETS, 'readwrite');
      const store = tx.objectStore(STORES.TARGETS);
      if (isTarget) {
        store.put({ commonName, isTarget: true, addedAt: new Date().toISOString() });
      } else {
        store.delete(commonName);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

/**
 * Put all targets in bulk (for import).
 * @param {Array<Object>} targets
 * @returns {Promise<void>}
 */
function putTargets(targets) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.TARGETS, 'readwrite');
      const store = tx.objectStore(STORES.TARGETS);
      for (const t of targets) {
        store.put(t);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

/**
 * Clear all targets.
 * @returns {Promise<void>}
 */
function clearTargets() {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.TARGETS, 'readwrite');
      const store = tx.objectStore(STORES.TARGETS);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

/* --------------------------------------------------------------------------
   Settings
   -------------------------------------------------------------------------- */

/**
 * Get a setting by key.
 * @param {string} key
 * @returns {Promise<any>}
 */
function getSetting(key) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.SETTINGS, 'readonly');
      const store = tx.objectStore(STORES.SETTINGS);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : null);
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Save a setting.
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
function setSetting(key, value) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.SETTINGS, 'readwrite');
      const store = tx.objectStore(STORES.SETTINGS);
      store.put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

/**
 * Get all settings as a plain object.
 * @returns {Promise<Object>}
 */
function getAllSettings() {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.SETTINGS, 'readonly');
      const store = tx.objectStore(STORES.SETTINGS);
      const request = store.getAll();
      request.onsuccess = () => {
        const obj = {};
        for (const item of request.result) {
          obj[item.key] = item.value;
        }
        resolve(obj);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Clear all settings.
 * @returns {Promise<void>}
 */
function clearSettings() {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.SETTINGS, 'readwrite');
      const store = tx.objectStore(STORES.SETTINGS);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

/* --------------------------------------------------------------------------
   Full DB wipe
   -------------------------------------------------------------------------- */

/**
 * Clear all stores in the database.
 * @returns {Promise<void>}
 */
function clearAll() {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [STORES.OBSERVATIONS, STORES.TARGETS, STORES.SETTINGS],
        'readwrite'
      );
      tx.objectStore(STORES.OBSERVATIONS).clear();
      tx.objectStore(STORES.TARGETS).clear();
      tx.objectStore(STORES.SETTINGS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  });
}

// Make the DB API available globally on window
window.DB = {
  openDB,
  putObservations,
  getObservations,
  getDistinctRegions,
  countObservations,
  clearObservations,
  getTargets,
  setTarget,
  putTargets,
  clearTargets,
  getSetting,
  setSetting,
  getAllSettings,
  clearSettings,
  clearAll,
  STORES,
};
