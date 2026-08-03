/**
 * IDB Encryption Layer — AES-GCM via Web Crypto API
 *
 * Encrypts PHI-bearing records in IndexedDB at rest. The encryption key is
 * derived from the user's auth token + a device-specific salt using PBKDF2.
 * The key lives in memory only during the active session — it is never
 * persisted to disk. When the user logs out or closes the browser, the key
 * is gone and the IDB data is unreadable ciphertext.
 *
 * Performance: AES-GCM via crypto.subtle is hardware-accelerated. Typical
 * overhead per record: 0.002-0.005ms. For 500 records: ~2ms total.
 */

// ─── Constants ───────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 100000;  // ~50ms one-time cost on login
const AES_KEY_LENGTH = 256;       // AES-256
const IV_LENGTH = 12;             // 96-bit IV for AES-GCM
const SALT_STORAGE_KEY = 'rxdeliver_idb_salt';

// Index fields to preserve as plaintext on the encrypted wrapper.
// These are the IDB index fields for each PHI store — they're needed for
// index-based queries (getByIndex, getByCompoundIndex, getByDate, etc.).
// None of these fields constitute PHI (they're metadata, not patient data).
const INDEX_FIELDS = {
  patients: ['id', 'store_id', 'updated_date'],
  deliveries: ['id', 'delivery_date', 'driver_id', 'store_id', 'updated_date', 'status', 'stop_order', 'stop_id'],
  app_users: ['id', 'user_id', 'app_roles', 'updated_date'],
  payroll: ['id', 'driver_id', 'pay_period_start', 'pay_period_end', 'updated_date'],
  square_transactions: ['id', 'delivery_id', 'updated_date', 'status'],
  rx_temp_logs: ['id', 'driver_id', 'delivery_date', 'updated_date'],
};
const KEY_VERSION_KEY = 'rxdeliver_idb_key_v';

// ─── State ────────────────────────────────────────────────────────────────

let _cryptoKey = null;        // CryptoKey in memory — gone on page unload
let _isInitialized = false;
let _isEncrypting = false;    // Flag: is encryption active?

// ─── Salt Management ─────────────────────────────────────────────────────

/**
 * Get or create a device-specific salt. This is stored in localStorage — it's
 * not secret, it just ensures different devices derive different keys.
 */
const getOrCreateSalt = () => {
  let salt = localStorage.getItem(SALT_STORAGE_KEY);
  if (!salt) {
    // Generate a 16-byte random salt
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(SALT_STORAGE_KEY, salt);
  }
  // Convert hex string back to Uint8Array
  const saltArr = new Uint8Array(salt.length / 2);
  for (let i = 0; i < salt.length; i += 2) {
    saltArr[i / 2] = parseInt(salt.substring(i, i + 2), 16);
  }
  return saltArr;
};

// ─── Key Derivation ──────────────────────────────────────────────────────

/**
 * Derive the AES-GCM key from the user's auth token + device salt.
 * Called once on login. The key stays in memory for the session.
 *
 * @param {string} authToken — The user's auth token (base44_access_token)
 * @returns {Promise<CryptoKey>}
 */
const deriveKey = async (authToken) => {
  if (!authToken) throw new Error('[IDB-Crypto] No auth token provided for key derivation');

  const salt = getOrCreateSalt();

  // Convert token to key material via PBKDF2
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(authToken),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  // Derive the AES-GCM key
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,  // non-extractable — can't be exported
    ['encrypt', 'decrypt']
  );

  return key;
};

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Initialize the encryption layer. Called after successful login.
 *
 * @param {string} authToken — The user's auth token
 * @returns {Promise<boolean>} — true if encryption is now active
 */
export const initEncryption = async (authToken) => {
  try {
    if (!authToken) {
      console.warn('[IDB-Crypto] No auth token — encryption disabled');
      _isEncrypting = false;
      _isInitialized = true;
      return false;
    }

    // Check if we already have a key for this token version
    const keyVersion = localStorage.getItem(KEY_VERSION_KEY);
    _cryptoKey = await deriveKey(authToken);
    _isEncrypting = true;
    _isInitialized = true;
    localStorage.setItem(KEY_VERSION_KEY, '1');

    console.log('[IDB-Crypto] Encryption initialized — AES-256-GCM active');
    return true;
  } catch (error) {
    console.error('[IDB-Crypto] Failed to initialize encryption:', error);
    // Graceful degradation: app still works, just unencrypted
    _isEncrypting = false;
    _isInitialized = true;
    return false;
  }
};

/**
 * Destroy the encryption key. Called on logout.
 */
export const destroyKey = () => {
  _cryptoKey = null;
  _isEncrypting = false;
  _isInitialized = false;
  console.log('[IDB-Crypto] Key destroyed — IDB data is now unreadable');
};

/**
 * Check if encryption is active.
 */
export const isEncrypting = () => _isEncrypting;

/**
 * Check if the encryption layer has been initialized.
 */
export const isInitialized = () => _isInitialized;

// ─── Encrypt / Decrypt ───────────────────────────────────────────────────

/**
 * Encrypt a record object. Returns the ciphertext as a Uint8Array.
 * If encryption is not active, returns the plaintext object unchanged.
 *
 * @param {object} record — The record to encrypt
 * @returns {Promise<object>} — { __encrypted: true, __data: Uint8Array }
 *   or the original record if encryption is off
 */
export const encryptRecord = async (record) => {
  if (!_isEncrypting || !_cryptoKey) return record;
  if (!record || typeof record !== 'object') return record;

  try {
    // Generate a unique IV for this record
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    // Serialize the FULL record (all fields including PHI)
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(JSON.stringify(record));

    // Encrypt
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      _cryptoKey,
      plaintext
    );

    // Build the encrypted byte blob: IV + ciphertext
    const encryptedBytes = new Uint8Array(iv.length + ciphertext.byteLength);
    encryptedBytes.set(iv, 0);
    encryptedBytes.set(new Uint8Array(ciphertext), iv.length);

    // Build wrapper: ciphertext + plaintext index fields for IDB queries.
    // The full record is inside __data (decrypted on read). The index fields
    // are copied as plaintext so IDB indexes still work. These fields are
    // NOT PHI — they're metadata needed for queries (delivery_date, driver_id, etc.).
    const wrapper = { __encrypted: true, __data: encryptedBytes };

    // Determine which index fields to preserve based on the store.
    // We try all known PHI store field lists and use whichever fields exist.
    for (const storeName in INDEX_FIELDS) {
      const fields = INDEX_FIELDS[storeName];
      for (const field of fields) {
        if (record[field] !== undefined) {
          wrapper[field] = record[field];
        }
      }
    }

    // CRITICAL: Always preserve id (IDB keyPath)
    if (record.id) wrapper.id = record.id;

    return wrapper;
  } catch (error) {
    console.error('[IDB-Crypto] Encrypt failed, returning plaintext:', error);
    return record;
  }
};

/**
 * Decrypt a record. If the record is not encrypted, returns it unchanged.
 *
 * @param {object} record — The record from IDB (may be encrypted or plaintext)
 * @returns {Promise<object>} — The decrypted record, or the original
 */
// Track decryption failures to throttle console spam
let _decryptFailCount = 0;
let _decryptFailLogged = 0;

export const decryptRecord = async (record) => {
  if (!record || typeof record !== 'object') return record;

  // Not encrypted — return as-is (handles migration + non-PHI stores)
  if (!record.__encrypted) return record;

  if (!_isEncrypting || !_cryptoKey) {
    // Encryption was on but key is gone — return degraded wrapper
    // (has plaintext index fields for queries, just missing full PHI data)
    _decryptFailCount++;
    return { ...record, __data: undefined, __decryptFailed: true };
  }

  try {
    const encryptedBytes = record.__data;
    if (!encryptedBytes || !(encryptedBytes instanceof Uint8Array)) {
      // Data corrupted or wrong format — return degraded wrapper
      return { ...record, __data: undefined, __decryptFailed: true };
    }

    // Extract IV (first 12 bytes) and ciphertext (rest)
    const iv = encryptedBytes.slice(0, IV_LENGTH);
    const ciphertext = encryptedBytes.slice(IV_LENGTH);

    // Decrypt
    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      _cryptoKey,
      ciphertext
    );

    // Reset fail counter on success
    _decryptFailCount = 0;

    // Deserialize
    const decoder = new TextDecoder();
    const json = decoder.decode(plaintextBuffer);
    return JSON.parse(json);
  } catch (error) {
    _decryptFailCount++;
    // Throttle console spam — log first 3, then every 50th
    if (_decryptFailLogged < 3 || _decryptFailCount % 50 === 0) {
      console.warn('[IDB-Crypto] Decrypt failed (count: ' + _decryptFailCount + ') — returning degraded record. Old key mismatch likely.');
      _decryptFailLogged++;
    }
    // Return degraded wrapper instead of null — preserves index fields
    // for queries. Server sync will overwrite with fresh data.
    return { ...record, __data: undefined, __decryptFailed: true };
  }
};

/**
 * Decrypt an array of records. Skips nulls from failed decryption.
 *
 * @param {Array} records — Array of encrypted or plaintext records
 * @returns {Promise<Array>} — Decrypted records
 */
export const decryptRecords = async (records) => {
  if (!records || !Array.isArray(records) || records.length === 0) return records;
  if (!_isEncrypting) return records;

  const results = await Promise.all(records.map(r => decryptRecord(r)));
  // Keep all records — degraded ones still have index fields for queries.
  // Filter only actual nulls (corrupt/empty), not degraded wrappers.
  return results.filter(r => r !== null && r !== undefined);
};

/**
 * Check if any records in a set are degraded (failed decryption).
 * Callers can use this to trigger a server re-sync.
 */
export const hasDegradedRecords = (records) => {
  if (!records || !Array.isArray(records)) return false;
  return records.some(r => r && r.__decryptFailed === true);
};

/**
 * Reset the decrypt failure counters (call after a successful re-sync).
 */
export const resetDecryptFailCounters = () => {
  _decryptFailCount = 0;
  _decryptFailLogged = 0;
};

/**
 * Purge undecryptable records from a store.
 * Returns the count of purged records. The next server sync will repopulate
 * with fresh data encrypted under the current key.
 */
export const purgeUndecryptableRecords = async (storeName, clearStoreFn) => {
  let purgedCount = 0;
  try {
    const db = await openDbForPurge(storeName);
    if (!db) return 0;
    const tx = db.transaction([storeName], 'readwrite');
    const store = tx.objectStore(storeName);
    const allReq = store.getAll();
    const allRecords = await new Promise((resolve) => {
      allReq.onsuccess = () => resolve(allReq.result || []);
      allReq.onerror = () => resolve([]);
    });
    for (const rec of allRecords) {
      if (rec?.__encrypted) {
        // Try decrypt — if it fails, delete the record
        try {
          const encryptedBytes = rec.__data;
          if (!encryptedBytes || !(encryptedBytes instanceof Uint8Array)) {
            store.delete(rec.id);
            purgedCount++;
            continue;
          }
          const iv = encryptedBytes.slice(0, IV_LENGTH);
          const ciphertext = encryptedBytes.slice(IV_LENGTH);
          await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, _cryptoKey, ciphertext);
        } catch {
          store.delete(rec.id);
          purgedCount++;
        }
      }
    }
    await new Promise((resolve) => { tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); });
    if (purgedCount > 0) {
      console.log(`[IDB-Crypto] Purged ${purgedCount} undecryptable records from ${storeName}`);
    }
  } catch (e) {
    // non-fatal
  }
  return purgedCount;
};

// Minimal IDB open for purge (avoids circular dependency with offlineDatabase)
let _purgeDb = null;
const openDbForPurge = async (storeName) => {
  if (_purgeDb) return _purgeDb;
  return new Promise((resolve) => {
    const req = indexedDB.open('rxdeliver_persistent_offline_v2');
    req.onsuccess = () => { _purgeDb = req.result; resolve(_purgeDb); };
    req.onerror = () => resolve(null);
  });
};

// ─── Migration ────────────────────────────────────────────────────────────

/**
 * Check if existing IDB records need migration (are plaintext but should be encrypted).
 * Reads a sample record from each PHI store.
 *
 * @returns {Promise<Array<string>>} — List of store names that need migration
 */
export const getStoresNeedingMigration = async (phiStoreNames) => {
  if (!_isEncrypting) return [];

  const needsMigration = [];
  for (const storeName of phiStoreNames) {
    try {
      // Open a read-only transaction and check the first record
      const db = (await import('./offlineDatabase.jsx')).offlineDB;
      const allRecords = await db.getAll(storeName);
      if (allRecords.length > 0 && !allRecords[0].__encrypted) {
        needsMigration.push(storeName);
      }
    } catch {
      // Store might not exist yet — skip
    }
  }
  return needsMigration;
};

/**
 * Migrate a single store: read all plaintext records, encrypt them, write back.
 *
 * @param {string} storeName — The IDB store to migrate
 * @param {Function} progressCallback — Called with (storeName, count)
 * @returns {Promise<number>} — Number of records migrated
 */
export const migrateStore = async (storeName, progressCallback) => {
  const db = (await import('./offlineDatabase.jsx')).offlineDB;

  // Read all records
  const allRecords = await db.getAll(storeName);
  if (!allRecords || allRecords.length === 0) return 0;

  // Check if already migrated (first record is encrypted)
  if (allRecords[0]?.__encrypted) return 0;

  // Encrypt each record
  const encryptedRecords = await Promise.all(allRecords.map(r => encryptRecord(r)));

  // Write back (use clearStore + bulkSave to ensure clean replacement)
  await db.clearStore(storeName);
  await db.bulkSave(storeName, encryptedRecords);

  if (progressCallback) progressCallback(storeName, encryptedRecords.length);
  return encryptedRecords.length;
};
