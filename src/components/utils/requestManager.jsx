const inFlightRequests = new Map();
const responseCache = new Map();

const toCacheKey = (key) => {
  if (typeof key === 'string') return key;
  return JSON.stringify(key);
};

export const requestManager = {
  get(key) {
    const cacheKey = toCacheKey(key);
    const cached = responseCache.get(cacheKey);
    if (!cached) return undefined;
    if (cached.expiresAt && cached.expiresAt <= Date.now()) {
      responseCache.delete(cacheKey);
      return undefined;
    }
    return cached.value;
  },

  set(key, value, ttlMs = 0) {
    const cacheKey = toCacheKey(key);
    responseCache.set(cacheKey, {
      value,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0
    });
    return value;
  },

  invalidate(key) {
    responseCache.delete(toCacheKey(key));
    inFlightRequests.delete(toCacheKey(key));
  },

  async memoized(key, requestFn, options = {}) {
    const cacheKey = toCacheKey(key);
    const { ttlMs = 0, cacheNull = false } = options;

    const cached = this.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    if (inFlightRequests.has(cacheKey)) {
      return inFlightRequests.get(cacheKey);
    }

    const requestPromise = Promise.resolve()
      .then(requestFn)
      .then((result) => {
        if (result !== undefined && (result !== null || cacheNull)) {
          this.set(cacheKey, result, ttlMs);
        }
        inFlightRequests.delete(cacheKey);
        return result;
      })
      .catch((error) => {
        inFlightRequests.delete(cacheKey);
        throw error;
      });

    inFlightRequests.set(cacheKey, requestPromise);
    return requestPromise;
  }
};