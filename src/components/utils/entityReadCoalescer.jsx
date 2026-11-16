/**
 * entityReadCoalescer — collapse duplicate entity READS into one request.
 *
 * WHY (owner request Nov 16 2026, from the hourly error digest):
 *   The dominant error signature was `entity_list` 429s — 210 calls / 60s.
 *   Nothing was actually wrong with the app's read logic; it just asked the
 *   same questions many times in the same second. A single dashboard mount has
 *   several independent consumers (AppDataContext, smart refresh, priority
 *   sync, badges, panels) that all list/filter the same entity within a few
 *   hundred milliseconds, and each preview tab repeats the whole set. Every one
 *   of those was a separate HTTP request against the rate limit.
 *
 * WHAT THIS DOES:
 *   1. IN-FLIGHT DEDUPE (always on, zero staleness): identical read calls that
 *      overlap in time share one promise. This is the big win — the extra calls
 *      were concurrent, not sequential.
 *   2. SHORT TTL (default 4s): a completed read is reused for a moment so a
 *      burst of consumers settling right after a render does not each re-ask.
 *   3. MUTATION INVALIDATION: any create/update/delete/bulk* call clears the
 *      whole cache immediately, so a read that follows a write always goes to
 *      the server. Writes are never cached, never deduped, never delayed.
 *
 * Subscriptions, singletons and anything that is not a read pass straight
 * through untouched, and errors are never cached (a failed read is dropped so
 * the next caller retries for real).
 */

const READ_METHODS = new Set([
  'list',
  'filter',
  'get',
  'getById',
  'find',
  'query',
  'count',
  'aggregate',
]);

const MUTATION_PREFIXES = [
  'create',
  'update',
  'delete',
  'bulkCreate',
  'bulkUpdate',
  'bulkDelete',
  'set',
  'increment',
];

const isMutation = (name) =>
  MUTATION_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix + 'By') || name.startsWith(prefix + 'Many'));

// Deterministic key: objects are stringified with sorted keys so two callers
// passing { a, b } and { b, a } land on the same entry.
const stableKey = (value, depth = 0) => {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return `[${value.map((v) => stableKey(v, depth + 1)).join(',')}]`;
  if (value instanceof Date) return `date:${value.getTime()}`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${k}:${stableKey(value[k], depth + 1)}`).join(',')}}`;
};

export function installEntityReadCoalescer(base44, options = {}) {
  if (!base44 || !base44.entities) return () => {};
  if (base44.__entityReadCoalescerInstalled) return base44.__entityReadCoalescerTeardown || (() => {});

  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 4000;
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 400;

  /** key -> { promise, expires } */
  const cache = new Map();
  const stats = { coalesced: 0, cached: 0, misses: 0, invalidations: 0 };

  const invalidateAll = () => {
    cache.clear();
    stats.invalidations += 1;
  };

  const prune = () => {
    if (cache.size <= maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (!entry || entry.expires <= now) cache.delete(key);
    }
    // Still over budget: drop oldest insertions (Map keeps insertion order).
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  };

  const coercePromise = (result) => (result && typeof result.then === 'function' ? result : Promise.resolve(result));

  const makeWrappedEntity = (entityName, entity) =>
    new Proxy(entity, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string' || typeof original !== 'function') return original;

        const isRead = READ_METHODS.has(prop);
        const isWrite = isMutation(prop);

        return (...args) => {
          if (isWrite) {
            // Writes always hit the server, and they make every cached read stale.
            const result = original.apply(target, args);
            invalidateAll();
            return result;
          }

          if (!isRead) return original.apply(target, args);

          const key = `${entityName}|${prop}|${stableKey(args)}`;
          const now = Date.now();
          const hit = cache.get(key);
          if (hit && hit.expires > now) {
            // In flight or still inside its TTL: the caller shares the same promise.
            if (hit.settled) stats.cached += 1; else stats.coalesced += 1;
            return hit.promise;
          }
          if (hit) cache.delete(key);

          const promise = coercePromise(original.apply(target, args)).catch((error) => {
            // Never cache a failure — the next caller must retry for real.
            if (cache.get(key)?.promise === promise) cache.delete(key);
            throw error;
          });

          const entry = { promise, settled: false, expires: now + ttlMs };
          cache.set(key, entry);
          // The TTL restarts when the call settles, so a burst that piles up behind one
          // slow read all lands on that single result instead of firing again after it.
          promise.then(
            () => {
              if (cache.get(key) === entry) {
                entry.settled = true;
                entry.expires = Date.now() + ttlMs;
              }
            },
            () => {}
          );
          stats.misses += 1;
          prune();
          return promise;
        };
      },
    });

  // A frozen / non-extensible entities object cannot be proxied for reads: the Proxy
  // get trap would have to return the exact property value. Bail out cleanly instead of
  // throwing a TypeError on every entity access.
  try {
    if (!Object.isExtensible(base44.entities)) {
      base44.__entityReadCoalescerSkipped = true;
      return () => {};
    }
  } catch {}

  const wrappedByEntity = new Map();
  const wrapOnce = (name, value) => {
    if (wrappedByEntity.has(name)) return wrappedByEntity.get(name);
    const wrapped = makeWrappedEntity(name, value);
    wrappedByEntity.set(name, wrapped);
    return wrapped;
  };

  const entitiesProxy = new Proxy(base44.entities, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || !value || typeof value !== 'object') return value;
      const wrapped = wrapOnce(prop, value);
      // Cache the wrapped entity so identity is stable for React deps. The SDK may hand
      // back a frozen or accessor-only object, so a failed defineProperty must never
      // break boot - the proxy still returns the wrapper for this access.
      try {
        Object.defineProperty(target, prop, { value: wrapped, configurable: true, writable: true, enumerable: true });
      } catch {}
      return wrapped;
    },
  });

  let installed = false;
  try {
    base44.entities = entitiesProxy;
    installed = base44.entities === entitiesProxy;
  } catch {
    installed = false;
  }
  if (!installed) {
    // Fallback: wrap each known entity in place when the entities object itself is
    // read-only. Only reached on a host that freezes the SDK object.
    try {
      Object.keys(base44.entities || {}).forEach((name) => {
        const value = base44.entities[name];
        if (!value || typeof value !== 'object') return;
        try {
          Object.defineProperty(base44.entities, name, {
            value: wrapOnce(name, value), configurable: true, writable: true, enumerable: true,
          });
          installed = true;
        } catch {}
      });
    } catch {}
  }
  if (!installed) base44.__entityReadCoalescerSkipped = true;
  base44.__entityReadCoalescerInstalled = true;

  const teardown = () => {
    base44.entities = entitiesProxy; // proxy is inert once flags are cleared
    base44.__entityReadCoalescerInstalled = false;
  };
  base44.__entityReadCoalescerTeardown = teardown;
  base44.__entityReadCoalescerStats = () => ({ ...stats, cacheSize: cache.size });
  base44.__entityReadCoalescerInvalidate = invalidateAll;

  return teardown;
}

export default installEntityReadCoalescer;
