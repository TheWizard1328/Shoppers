// base44/functions/rxServerRouteOptimizer/routeRules.js
var TIME_BAND_MINUTES = 120;
var PICKUP_DWELL_MINUTES = 15;
var DELIVERY_DWELL_MINUTES = 5;
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return Infinity;
  const parts = timeStr.split(":");
  if (parts.length < 2) return Infinity;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return Infinity;
  return h * 60 + m;
}
function formatMinutesToTime(totalMinutes) {
  const m = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function inheritedPickupWindowStart(pickupWindowStart) {
  const m = parseTimeToMinutes(pickupWindowStart);
  if (m === Infinity || m <= 0) return null;
  return formatMinutesToTime(m + 5);
}
function windowBandOfStop(stop, { routeIsToday, currentMinutes, windowOf }) {
  const nowBand = Math.floor(currentMinutes / TIME_BAND_MINUTES);
  const m = parseTimeToMinutes(windowOf(stop) || "");
  if (!Number.isFinite(m) || m <= 0) return nowBand;
  if (routeIsToday && m <= currentMinutes) return nowBand;
  return Math.floor(m / TIME_BAND_MINUTES);
}
function windowBandSort(stops, { routeIsToday, currentMinutes, windowOf }) {
  const bandOf = (stop) => windowBandOfStop(stop, { routeIsToday, currentMinutes, windowOf });
  const inputOrder = new Map((stops || []).map((s, i) => [s, i]));
  return [...stops || []].sort((a, b) => {
    const bandDiff = bandOf(a) - bandOf(b);
    if (bandDiff !== 0) return bandDiff;
    return (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0);
  });
}
function enforceIspBeforeIsd(stops, adapters) {
  const {
    idOf = (s) => s.id,
    deliveryIdOf = (s) => s.deliveryId,
    puidOf = (s) => s.puid,
    stopIdOf = (s) => s.stopId
  } = adapters || {};
  let ordered = [...stops || []];
  const ispByStopId = new Map(ordered.filter((s) => String(deliveryIdOf(s) || "").startsWith("ISP")).map((s) => [String(stopIdOf(s)), s]));
  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let i = 0; i < ordered.length; i++) {
      const stop = ordered[i];
      if (String(deliveryIdOf(stop) || "").startsWith("ISD") && puidOf(stop)) {
        const linkedISP = ispByStopId.get(String(puidOf(stop)));
        if (!linkedISP) continue;
        const ispIdx = ordered.findIndex((s) => idOf(s) === idOf(linkedISP));
        if (ispIdx > i) {
          const tmp = ordered[i];
          ordered[i] = ordered[ispIdx];
          ordered[ispIdx] = tmp;
          swapped = true;
          break;
        }
      }
    }
  }
  return ordered;
}
function isPolylineEligibleStop({ status, isCyclingMarker, transportMode }) {
  const st = String(status || "").toLowerCase();
  if (st === "en_route" || st === "in_transit") return true;
  if (isCyclingMarker === true) return true;
  if (String(transportMode || "").toLowerCase() === "cycling") return true;
  return false;
}
function dwellMinutesForStop({ extraTime, isPickup }) {
  const extra = Number(extraTime);
  if (Number.isFinite(extra) && extra > 0) return extra;
  return isPickup ? PICKUP_DWELL_MINUTES : DELIVERY_DWELL_MINUTES;
}

// .repro/at/api/base44Client.js
var base44 = {
  entities: { AppUser: { filter: async () => [] } },
  functions: { invoke: async () => ({}) },
  auth: { me: async () => null }
};

// .repro/at/components/utils/interStoreDisplayName.js
var getInterStoreLocationSync = () => null;
var isInterStoreDelivery = () => false;

// .repro/at/components/utils/geoUtils.js
var EARTH_RADIUS_KM = 6371;
var haversineKm = (lat1, lon1, lat2, lon2) => {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
};

// .repro/at/components/utils/clientRouteGoogle.js
var calculateCrowFliesDistance = (lat1, lng1, lat2, lng2) => haversineKm(lat1, lng1, lat2, lng2);
function encodePolylineValue(value) {
  let v = value < 0 ? -value * 2 - 1 : value * 2;
  let result = "";
  while (v >= 32) {
    result += String.fromCharCode(32 + v % 32 + 63);
    v = Math.floor(v / 32);
  }
  result += String.fromCharCode(v + 63);
  return result;
}
function encodeGooglePolyline(points) {
  let lastLat = 0, lastLng = 0, encoded = "";
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    encoded += encodePolylineValue(latE5 - lastLat);
    encoded += encodePolylineValue(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }
  return encoded;
}
async function getMultiStopRouteGoogle(points, transportMode, _googleApiKey, _opts = {}) {
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return { sections: [], usedFallbackPolyline: false };
  try {
    const res = await base44.functions.invoke("getGoogleDirectionsPolyline", {
      points: validPoints,
      transportMode,
      ..._opts?.purpose ? { purpose: _opts.purpose } : {}
    });
    const data = res?.data || res || {};
    let sections = Array.isArray(data.sections) ? data.sections : [];
    let usedFallbackPolyline = !!data.usedFallbackPolyline;
    return { sections, usedFallbackPolyline };
  } catch (err) {
    console.warn("[clientRouteGoogle] backend Google Directions call failed, using local crow-flies:", err?.message || err);
    const allSections = [];
    for (let i = 0; i < validPoints.length - 1; i++) {
      const from = validPoints[i], to = validPoints[i + 1];
      const d = calculateCrowFliesDistance(from.lat, from.lon, to.lat, to.lon);
      allSections.push({
        encoded_polyline: encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]),
        estimated_distance_km: Number(d.toFixed(3)),
        estimated_duration_minutes: Math.ceil(d / 40 * 60),
        transport_mode: transportMode || "driving"
      });
    }
    return { sections: allSections, usedFallbackPolyline: true };
  }
}

// .repro/at/components/utils/connectionMonitor.jsx
var MAX_SAMPLES = 10;
var DEGRADED_HOLD_MS = 3e4;
var getNavigatorOnline = () => typeof navigator === "undefined" ? true : navigator.onLine !== false;
var getNetworkInformation = () => {
  if (typeof navigator === "undefined") return null;
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
};
var classifyNetworkInformation = (connection) => {
  if (!connection) return "good";
  const effectiveType = String(connection.effectiveType || "").toLowerCase();
  const rtt = Number(connection.rtt);
  const downlink = Number(connection.downlink);
  if (effectiveType === "slow-2g" || effectiveType === "2g") return "poor";
  if (effectiveType === "3g") return "fair";
  if (Number.isFinite(rtt) && rtt >= 1200) return "poor";
  if (Number.isFinite(rtt) && rtt >= 650) return "fair";
  if (Number.isFinite(downlink) && downlink > 0 && downlink <= 0.5) return "poor";
  if (Number.isFinite(downlink) && downlink > 0 && downlink <= 1.5) return "fair";
  return "good";
};
var ConnectionMonitor = class {
  constructor() {
    this.isOnline = getNavigatorOnline();
    this.connection = getNetworkInformation();
    this.responseTimeSamples = [];
    this.listeners = /* @__PURE__ */ new Set();
    this.degradedUntil = 0;
    this.rateLimitedUntil = 0;
    this.lastErrorType = null;
    this._degradeTimer = null;
    this.quality = this.isOnline ? classifyNetworkInformation(this.connection) : "offline";
    if (typeof window !== "undefined") {
      this._handleOnline = () => this.handleOnline();
      this._handleOffline = () => this.handleOffline();
      this._handleConnectionChange = () => this.recalculate();
      window.addEventListener("online", this._handleOnline);
      window.addEventListener("offline", this._handleOffline);
      this.connection?.addEventListener?.("change", this._handleConnectionChange);
    }
  }
  handleOnline() {
    this.isOnline = true;
    this.quality = classifyNetworkInformation(this.connection) === "good" ? "fair" : classifyNetworkInformation(this.connection);
    this.notifyListeners();
    clearTimeout(this._degradeTimer);
    this._degradeTimer = setTimeout(() => this.recalculate(), 1e4);
  }
  handleOffline() {
    this.isOnline = false;
    this.quality = "offline";
    this.lastErrorType = "offline";
    this.notifyListeners();
  }
  recordResponseTime(timeMs) {
    if (!Number.isFinite(timeMs) || timeMs < 0) return;
    this.isOnline = getNavigatorOnline();
    if (!this.isOnline) {
      this.handleOffline();
      return;
    }
    this.responseTimeSamples.push({ time: timeMs, timestamp: Date.now() });
    if (this.responseTimeSamples.length > MAX_SAMPLES) this.responseTimeSamples.shift();
    this.lastErrorType = null;
    this.degradedUntil = 0;
    this.rateLimitedUntil = 0;
    this.recalculate();
  }
  recordSuccess(timeMs = null) {
    if (Number.isFinite(timeMs)) {
      this.recordResponseTime(timeMs);
      return;
    }
    this.isOnline = getNavigatorOnline();
    this.lastErrorType = null;
    this.degradedUntil = 0;
    this.rateLimitedUntil = 0;
    this.recalculate();
  }
  recordError(errorType = "network") {
    this.isOnline = getNavigatorOnline();
    this.lastErrorType = errorType;
    if (errorType === "rate_limit") {
      this.rateLimitedUntil = Date.now() + DEGRADED_HOLD_MS;
      this.recalculate();
      return;
    }
    this.degradedUntil = Date.now() + DEGRADED_HOLD_MS;
    this.quality = this.isOnline ? "poor" : "offline";
    this.notifyListeners();
    clearTimeout(this._degradeTimer);
    this._degradeTimer = setTimeout(() => this.recalculate(), DEGRADED_HOLD_MS + 100);
  }
  recalculate() {
    this.isOnline = getNavigatorOnline();
    if (!this.isOnline) {
      this.quality = "offline";
      this.notifyListeners();
      return;
    }
    const browserQuality = classifyNetworkInformation(this.connection);
    if (Date.now() < this.degradedUntil) {
      this.quality = "poor";
    } else {
      const recent = this.responseTimeSamples.filter((sample) => Date.now() - sample.timestamp <= 12e4);
      const average = recent.length ? recent.reduce((sum, sample) => sum + sample.time, 0) / recent.length : null;
      const measuredQuality = average == null ? "good" : average >= 5e3 ? "poor" : average >= 2e3 ? "fair" : "good";
      this.quality = browserQuality === "poor" || measuredQuality === "poor" ? "poor" : browserQuality === "fair" || measuredQuality === "fair" ? "fair" : "good";
    }
    this.notifyListeners();
  }
  canAttemptNetwork() {
    return this.isOnline && this.quality !== "poor" && Date.now() >= this.rateLimitedUntil;
  }
  getAverageResponseTime() {
    if (!this.responseTimeSamples.length) return null;
    return Math.round(this.responseTimeSamples.reduce((sum, sample) => sum + sample.time, 0) / this.responseTimeSamples.length);
  }
  getQuality() {
    return {
      quality: this.quality,
      isOnline: this.isOnline,
      avgResponseTime: this.getAverageResponseTime(),
      effectiveType: this.connection?.effectiveType || null,
      downlink: Number.isFinite(Number(this.connection?.downlink)) ? Number(this.connection.downlink) : null,
      rtt: Number.isFinite(Number(this.connection?.rtt)) ? Number(this.connection.rtt) : null,
      lastErrorType: this.lastErrorType
    };
  }
  subscribe(callback) {
    this.listeners.add(callback);
    try {
      callback(this.getQuality());
    } catch {
    }
    return () => this.listeners.delete(callback);
  }
  notifyListeners() {
    const status = this.getQuality();
    this.listeners.forEach((callback) => {
      try {
        callback(status);
      } catch {
      }
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("connectionHealthChanged", { detail: status }));
    }
  }
};
var connectionMonitor = new ConnectionMonitor();

// .repro/at/components/utils/requestQueue.jsx
var MIN_REQUEST_INTERVAL = 600;
var DEDUP_WINDOW = 500;
var REQUEST_TIMEOUT_MS = 15e3;
var RequestQueue = class {
  constructor() {
    this.lastRequestTime = 0;
    this.queue = [];
    this.processing = false;
    this.pendingRequests = /* @__PURE__ */ new Map();
    this.rateLimitUntil = 0;
    this.rateLimitBackoffMs = 3e4;
  }
  /**
   * Emergency unstick: if `processing` was left true by a path that bypassed the
   * per-request timeout race (should no longer happen, but belt-and-suspenders),
   * reset it and drop stale waits. Called by smartRefreshManager.checkHeartbeatAndSync().
   */
  forceUnstick() {
    if (!this.processing && this.queue.length === 0) return false;
    console.warn(`\u{1F527} [RequestQueue] Force-unsticking queue (${this.queue.length} waiting) \u2014 processing was ${this.processing}`);
    this.processing = false;
    this.queue.length = 0;
    return true;
  }
  /**
   * Generate a hash key for deduplication
   */
  generateRequestKey(requestName) {
    return `${requestName}`;
  }
  /**
   * Queue a request and wait for appropriate spacing
   */
  async enqueue(requestFn, requestName = "unknown") {
    const requestKey = this.generateRequestKey(requestName);
    const now = Date.now();
    if (this.pendingRequests.has(requestKey)) {
      const { promise: promise2, timestamp } = this.pendingRequests.get(requestKey);
      if (now - timestamp < DEDUP_WINDOW) {
        console.log(`\u{1F504} [RequestQueue] Deduplicating request: "${requestName}" (merged with pending)`);
        return promise2;
      } else {
        this.pendingRequests.delete(requestKey);
      }
    }
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ requestFn, requestName, resolve, reject });
      this.processQueue();
    });
    this.pendingRequests.set(requestKey, { promise, timestamp: now });
    setTimeout(() => {
      if (this.pendingRequests.get(requestKey)?.timestamp === now) {
        this.pendingRequests.delete(requestKey);
      }
    }, DEDUP_WINDOW);
    return promise;
  }
  /**
   * Process queued requests with spacing
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    this.processing = true;
    while (this.queue.length > 0) {
      const { requestFn, requestName, resolve, reject } = this.queue.shift();
      const rateWait = this.rateLimitUntil - Date.now();
      if (rateWait > 0) {
        console.warn(`\u23F0 [RequestQueue] Rate-limited \u2014 pausing ${Math.round(rateWait / 1e3)}s before "${requestName}"`);
        await new Promise((r) => setTimeout(r, rateWait));
      }
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      const waitTime = Math.max(0, MIN_REQUEST_INTERVAL - timeSinceLastRequest);
      if (waitTime > 0) {
        console.log(`\u23F3 [RequestQueue] Spacing request "${requestName}" - waiting ${waitTime}ms`);
        await new Promise((r) => setTimeout(r, waitTime));
      }
      this.lastRequestTime = Date.now();
      let timeoutId;
      try {
        console.log(`\u{1F4E4} [RequestQueue] Executing request: "${requestName}"`);
        const timeoutPromise = new Promise((_, timeoutReject) => {
          timeoutId = setTimeout(
            () => timeoutReject(new Error(`Request "${requestName}" timed out after ${REQUEST_TIMEOUT_MS / 1e3}s`)),
            REQUEST_TIMEOUT_MS
          );
        });
        const requestStartedAt = Date.now();
        const result = await Promise.race([requestFn(), timeoutPromise]);
        clearTimeout(timeoutId);
        connectionMonitor.recordResponseTime(Date.now() - requestStartedAt);
        this.rateLimitBackoffMs = 3e4;
        resolve(result);
      } catch (error) {
        clearTimeout(timeoutId);
        const is429 = error?.response?.status === 429 || error?.status === 429 || error?.code === 429 || error?.message && (/429/.test(error.message) || /rate limit/i.test(error.message));
        if (is429) {
          connectionMonitor.recordError("rate_limit");
          this.rateLimitUntil = Date.now() + this.rateLimitBackoffMs;
          this.rateLimitBackoffMs = this.rateLimitBackoffMs === 3e4 ? 6e4 : this.rateLimitBackoffMs;
          console.warn(`\u23F0 [RequestQueue] 429 on "${requestName}" \u2014 backing off ${Math.round(this.rateLimitBackoffMs / 1e3)}s (all queued callers paused)`);
        } else {
          connectionMonitor.recordError(/timed out|timeout/i.test(String(error?.message || "")) ? "timeout" : "network");
          console.warn(`\u274C [RequestQueue] Request failed: "${requestName}" -`, error?.message || error);
        }
        reject(error);
      }
    }
    this.processing = false;
  }
  /**
   * Check if the queue is currently in a rate-limit backoff window
   */
  isRateLimited() {
    return Date.now() < this.rateLimitUntil;
  }
  /**
   * Get queue length (for debugging)
   */
  getQueueLength() {
    return this.queue.length;
  }
  /**
   * Clear queue (e.g., on rate limit error)
   */
  clear() {
    const cleared = this.queue.length;
    this.queue = [];
    console.log(`\u{1F5D1}\uFE0F [RequestQueue] Cleared ${cleared} queued requests`);
    return cleared;
  }
};
var requestQueue = new RequestQueue();
async function queueEntityRequest(requestFn, requestName = "entity request") {
  return requestQueue.enqueue(requestFn, requestName);
}

// .repro/at/components/utils/appSettingsCache.js
var MEMORY_TTL_MS = 60 * 1e3;
var IDB_BG_REFRESH_MS = 10 * 60 * 1e3;
var _memory = /* @__PURE__ */ new Map();
var _inflight = /* @__PURE__ */ new Map();
var _listenerBound = false;
var _bindWsListener = () => {
  if (_listenerBound || typeof window === "undefined") return;
  _listenerBound = true;
  window.addEventListener("appSettingsUpdated", (event) => {
    const updated = event?.detail?.data || event?.detail;
    if (!updated?.setting_key) return;
    _memory.set(updated.setting_key, { rows: [updated], fetchedAt: Date.now() });
    (async () => {
      try {
        const { offlineDB } = await import("@/components/utils/offlineDatabase");
        await offlineDB.save(offlineDB.STORES.APP_SETTINGS, { ...updated, _fetched_at: Date.now() });
      } catch (_) {
      }
    })();
  });
};
var _loadIdbRows = async (settingKey) => {
  try {
    const { offlineDB } = await import("@/components/utils/offlineDatabase");
    const rows = await offlineDB.getByIndex(offlineDB.STORES.APP_SETTINGS, "setting_key", settingKey);
    return _sortFreshest(rows);
  } catch (_) {
    return null;
  }
};
var _sortFreshest = (rows) => (rows || []).filter(Boolean).sort((a, b) => String(b?.updated_date || "").localeCompare(String(a?.updated_date || "")));
var _saveIdbRows = async (settingKey, rows) => {
  try {
    const { offlineDB } = await import("@/components/utils/offlineDatabase");
    const stamped = (rows || []).map((r) => ({ ...r, _fetched_at: Date.now() }));
    const existing = await offlineDB.getByIndex(offlineDB.STORES.APP_SETTINGS, "setting_key", settingKey).catch(() => []);
    const freshIds = new Set(stamped.map((r) => r.id));
    for (const old of existing || []) {
      if (old?.id && !freshIds.has(old.id)) {
        await offlineDB.deleteRecord(offlineDB.STORES.APP_SETTINGS, old.id).catch(() => {
        });
      }
    }
    if (stamped.length) await offlineDB.bulkSave(offlineDB.STORES.APP_SETTINGS, stamped);
  } catch (_) {
  }
};
var _fetchFromApi = (settingKey) => {
  _bindWsListener();
  let p = _inflight.get(settingKey);
  if (p) return p;
  p = queueEntityRequest(async () => {
    const rows = await base44.entities.AppSettings.filter({ setting_key: settingKey });
    const list = _sortFreshest(rows);
    _memory.set(settingKey, { rows: list, fetchedAt: Date.now() });
    await _saveIdbRows(settingKey, list);
    return list;
  }, `appSettingsCache:${settingKey}`);
  _inflight.set(settingKey, p);
  p.catch(() => {
  }).finally(() => _inflight.delete(settingKey));
  return p;
};
async function getAppSettingRows(settingKey) {
  if (!settingKey) return [];
  _bindWsListener();
  const mem = _memory.get(settingKey);
  if (mem && Date.now() - mem.fetchedAt < MEMORY_TTL_MS) return mem.rows;
  const idbRows = await _loadIdbRows(settingKey);
  if (idbRows && idbRows.length > 0) {
    _memory.set(settingKey, { rows: idbRows, fetchedAt: Date.now() });
    const oldest = idbRows.reduce((m, r) => Math.min(m, r?._fetched_at || 0), Infinity);
    if (Date.now() - oldest > IDB_BG_REFRESH_MS) _fetchFromApi(settingKey).catch(() => {
    });
    return idbRows;
  }
  try {
    return await _fetchFromApi(settingKey);
  } catch (_) {
    return [];
  }
}

// .repro/at/components/utils/winterModeSettings.js
var DEFAULT_WINTER_MODE = Object.freeze({
  enabled: false,
  eta_factor: 1.25,
  gps_snap_km: 0.15,
  arrival_radius_m: 150,
  cold_threshold_min_c: -15,
  // enable cold warning at or below this temp
  cold_threshold_max_c: -5,
  // disable cold warning at or above this temp
  breadcrumb_accuracy_gate_m: 100
  // drop GPS fixes ≥ this accuracy (m) from the breadcrumb chain buffer
});
var CACHE_TTL_MS = 5 * 60 * 1e3;
var _cached = null;
var _fetchedAt = 0;
var _fetchPromise = null;
function invalidateWinterModeCache() {
  _cached = null;
  _fetchedAt = 0;
}
async function getWinterModeSettings({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cached && now - _fetchedAt < CACHE_TTL_MS) return _cached;
  if (_fetchPromise) return _fetchPromise;
  _fetchPromise = (async () => {
    try {
      const rows = await getAppSettingRows("refresh_intervals");
      const raw = rows?.[0]?.setting_value?.winter_mode;
      const merged = { ...DEFAULT_WINTER_MODE, ...raw && typeof raw === "object" ? raw : {} };
      if (!Number.isFinite(merged.eta_factor) || merged.eta_factor < 1 || merged.eta_factor > 3) merged.eta_factor = DEFAULT_WINTER_MODE.eta_factor;
      if (!Number.isFinite(merged.gps_snap_km) || merged.gps_snap_km <= 0 || merged.gps_snap_km > 1) merged.gps_snap_km = DEFAULT_WINTER_MODE.gps_snap_km;
      if (!Number.isFinite(merged.arrival_radius_m) || merged.arrival_radius_m <= 0) merged.arrival_radius_m = DEFAULT_WINTER_MODE.arrival_radius_m;
      if (!Number.isFinite(merged.cold_threshold_min_c)) merged.cold_threshold_min_c = DEFAULT_WINTER_MODE.cold_threshold_min_c;
      if (!Number.isFinite(merged.cold_threshold_max_c)) merged.cold_threshold_max_c = DEFAULT_WINTER_MODE.cold_threshold_max_c;
      if (!Number.isFinite(merged.breadcrumb_accuracy_gate_m) || merged.breadcrumb_accuracy_gate_m <= 0) merged.breadcrumb_accuracy_gate_m = DEFAULT_WINTER_MODE.breadcrumb_accuracy_gate_m;
      merged.enabled = merged.enabled === true;
      _cached = merged;
      _fetchedAt = Date.now();
      return merged;
    } catch {
      _cached = _cached || { ...DEFAULT_WINTER_MODE };
      return _cached;
    } finally {
      _fetchPromise = null;
    }
  })();
  return _fetchPromise;
}
if (typeof window !== "undefined") {
  window.addEventListener?.("appSettingsUpdated", () => invalidateWinterModeCache());
}

// .repro/at/components/utils/routePolylineGenerator.js
var isLegOrderStampStale = (delivery) => {
  if (!delivery || typeof delivery.encoded_polyline !== "string" || delivery.encoded_polyline.length <= 10) return true;
  const stamp = Number(delivery.polyline_from_order);
  const currentOrder = Number(delivery.stop_order);
  if (!Number.isFinite(stamp) || !Number.isFinite(currentOrder)) return true;
  return stamp !== currentOrder;
};
async function logHereApiCall({ apiType, purpose, source, driverId, userName, callCount = 1 }) {
  try {
    await base44.entities.GoogleAPILog.create({
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      api_type: apiType,
      purpose: purpose || apiType,
      function_name: source || "clientRouteEngine",
      user_id: driverId || null,
      user_name: userName || null,
      metadata: {
        provider: "HERE",
        source: source || "client",
        call_count: callCount
      }
    });
  } catch {
  }
}
var HERE_POLYLINE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
var HERE_POLYLINE_DECODER = HERE_POLYLINE_ALPHABET.split("").reduce((acc, char, index) => {
  acc[char] = index;
  return acc;
}, {});
function decodeHereFlexiblePolyline(encoded) {
  if (!encoded || typeof encoded !== "string") return [];
  const values = [];
  let current = 0;
  let shift = 0;
  for (const char of encoded) {
    const value = HERE_POLYLINE_DECODER[char];
    if (value == null) return [];
    current |= (value & 31) << shift;
    if (value & 32) {
      shift += 5;
      continue;
    }
    values.push(current);
    current = 0;
    shift = 0;
  }
  if (shift > 0 || values.length < 2) return [];
  if (values[0] !== 1) return [];
  const header = values[1];
  const precision = header & 15;
  const thirdDimension = header >> 4 & 7;
  const factor = 10 ** precision;
  const dimension = thirdDimension ? 3 : 2;
  const toSigned = (value) => value & 1 ? ~(value >> 1) : value >> 1;
  let latitude = 0, longitude = 0, third = 0;
  const coordinates = [];
  for (let i = 2; i < values.length; i += dimension) {
    latitude += toSigned(values[i]);
    longitude += toSigned(values[i + 1]);
    if (thirdDimension) third += toSigned(values[i + 2]);
    coordinates.push([latitude / factor, longitude / factor]);
  }
  return coordinates;
}
function encodeSigned(value) {
  let signed = value << 1;
  if (value < 0) signed = ~signed;
  let encoded = "";
  while (signed >= 32) {
    encoded += String.fromCharCode((32 | signed & 31) + 63);
    signed >>= 5;
  }
  encoded += String.fromCharCode(signed + 63);
  return encoded;
}
function encodeGooglePolyline2(points) {
  let lastLat = 0, lastLng = 0, encoded = "";
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    encoded += encodeSigned(latE5 - lastLat);
    encoded += encodeSigned(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }
  return encoded;
}
function decodeGooglePolyline(encoded) {
  if (!encoded || typeof encoded !== "string") return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let result = 0, multiplier = 1, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result += byte % 32 * multiplier;
      multiplier *= 32;
    } while (byte >= 32);
    lat += result % 2 !== 0 ? -((result + 1) / 2) : result / 2;
    result = 0;
    multiplier = 1;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result += byte % 32 * multiplier;
      multiplier *= 32;
    } while (byte >= 32);
    lng += result % 2 !== 0 ? -((result + 1) / 2) : result / 2;
    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
}
function mergeGooglePolylines(first, second) {
  if (!first) return second || null;
  if (!second) return first || null;
  const a = decodeGooglePolyline(first);
  const b = decodeGooglePolyline(second);
  if (a.length === 0) return second;
  if (b.length === 0) return first;
  return encodeGooglePolyline2([...a, ...b.slice(1)]);
}
async function getMultiStopRouteHere(points, transportMode, hereApiKey, { driverId = null, userName = null, logPurpose = null } = {}) {
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return { sections: [], usedFallbackPolyline: false };
  const hereTransportMode = transportMode === "cycling" ? "bicycle" : transportMode === "pedestrian" ? "pedestrian" : "car";
  const params = new URLSearchParams();
  params.set("apiKey", hereApiKey);
  params.set("transportMode", hereTransportMode);
  params.set("origin", `${validPoints[0].lat},${validPoints[0].lon}`);
  params.set("destination", `${validPoints[validPoints.length - 1].lat},${validPoints[validPoints.length - 1].lon}`);
  params.set("return", "polyline,summary");
  const viaPoints = validPoints.slice(1, -1);
  viaPoints.forEach((p) => params.append("via", `${p.lat},${p.lon}`));
  const routeResp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
    signal: AbortSignal.timeout(2e4),
    headers: { accept: "application/json" }
  });
  logHereApiCall({ apiType: "Routes (HERE)", purpose: logPurpose || `Polyline generation \u2014 ${validPoints.length - 1} leg(s), mode=${hereTransportMode}`, source: "getMultiStopRouteHere", driverId, userName }).catch(() => {
  });
  const routeData = await routeResp.json().catch(() => null);
  const routeSections = Array.isArray(routeData?.routes?.[0]?.sections) ? routeData.routes[0].sections : [];
  if (!routeResp.ok || routeSections.length === 0) {
    console.warn("[routePolylineGenerator] HERE Router returned no sections", {
      httpStatus: routeResp.status,
      sectionsCount: routeSections.length,
      notice: routeData?.notices ?? routeData?.title ?? null
    });
  }
  let anySegmentFellBack = false;
  const builtSections = validPoints.slice(0, -1).map((fromPoint, index) => {
    const section = routeSections[index] || {};
    let polyline = null;
    if (typeof section?.polyline === "string" && section.polyline) {
      const coords = decodeHereFlexiblePolyline(section.polyline);
      if (coords.length > 1) polyline = encodeGooglePolyline2(coords);
    }
    if (!polyline && typeof section?.encoded_polyline === "string" && section.encoded_polyline) {
      polyline = section.encoded_polyline;
    }
    if (!polyline) {
      const toPoint = validPoints[index + 1];
      polyline = encodeGooglePolyline2([[fromPoint.lat, fromPoint.lon], [toPoint.lat, toPoint.lon]]);
      anySegmentFellBack = true;
    }
    const summary = section?.summary || {};
    return {
      encoded_polyline: polyline,
      estimated_distance_km: summary.length ? Number((Number(summary.length) / 1e3).toFixed(3)) : null,
      estimated_duration_minutes: summary.duration ? Math.ceil(Number(summary.duration) / 60) : null,
      transport_mode: transportMode || "driving"
    };
  });
  return { sections: builtSections, usedFallbackPolyline: anySegmentFellBack };
}
var SAME_ANCHOR_TRAVEL_MINUTES = 2;
var sameAnchorLeg = (anchorPoint, stopPoint) => {
  const a = { lat: Number(anchorPoint?.lat), lon: Number(anchorPoint?.lon) };
  const b = { lat: Number(stopPoint?.lat), lon: Number(stopPoint?.lon) };
  if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return null;
  const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
  if (!(km < 0.05)) return null;
  return {
    encoded: encodeGooglePolyline2([[a.lat, a.lon], [b.lat, b.lon]]),
    durationMinutes: SAME_ANCHOR_TRAVEL_MINUTES,
    distanceKm: Number(km.toFixed(3))
  };
};
function crowFliesSections(points, transportMode) {
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return [];
  const mode = transportMode || "driving";
  return validPoints.slice(0, -1).map((from, i) => {
    const to = validPoints[i + 1];
    const km = haversineKm(from.lat, from.lon, to.lat, to.lon);
    return {
      encoded_polyline: encodeGooglePolyline2([[from.lat, from.lon], [to.lat, to.lon]]),
      estimated_distance_km: Number(km.toFixed(3)),
      estimated_duration_minutes: Math.ceil(km / 40 * 60),
      transport_mode: mode
    };
  });
}
async function generateRoutePolylines({
  stops,
  // [{ delivery, lat, lng }] — ordered stops with coords already resolved
  originPoint,
  // { lat, lon } or null (null → first eligible stop is origin, no inbound leg)
  cyclingSegmentOnly = false,
  hereApiKey,
  polylineProvider = "here",
  polylineApiKey = null,
  driverId = null,
  userName = null,
  source = "client_engine",
  fallbackTravelMode = "driving",
  directionsLegs = null,
  // optional: array to sync durations into (main path only)
  routeStops = null,
  // optional: full routeStops for directionsLegs index lookup (main path only)
  viaPointAfterOrigin = null,
  // { lat, lon } live driver GPS — inserted as a via waypoint
  // right after the origin (first mode group only). Current-leg
  // polyline bends through the driver's position; the first
  // stop's ETA/distance metrics use the GPS→stop leg only.
  forceRegenerate = false,
  // OWNER REQUEST (Oct 15 2026): the Quick Route Adjustments
  // Regenerate button demands ALL remaining stops get fresh
  // polylines even when no stop changed order. When true, the
  // order-unchanged leg-reuse block below never runs.
  orderUnchanged = false,
  // OWNER REQUEST (Oct 5 2026): the optimizer produced the
  // SAME stop order as the deliveries' existing stop_order.
  // The legs are identical geometry, so polyline generation
  // is skipped entirely (ETAs still update from HERE
  // sequencing) — unless the current leg actually differs:
  // if any eligible leg is missing, the origin anchor moved,
  // or the live-GPS via point applies, ONLY that leg regenerates.
  logPurpose = null
  // Optional override for the Maps API usage-log purpose
  // (e.g. 'Route Deviation (Google Directions) — Current Route Leg').
  // Null → default 'Polyline generation' labels, unchanged.
}) {
  const polylineByDeliveryId = /* @__PURE__ */ new Map();
  if (!hereApiKey) return polylineByDeliveryId;
  const winter = await getWinterModeSettings().catch(() => null);
  const _winterPad = (minutes, mode) => {
    if (!winter?.enabled || !minutes || Number(minutes) <= 0) return minutes ? Number(minutes) : null;
    if (mode === "cycling") return Number(minutes);
    return Math.ceil(Number(minutes) * winter.eta_factor);
  };
  const resolveMode = (delivery) => {
    const raw = String(delivery?.transport_mode || fallbackTravelMode).toLowerCase();
    if (raw === "cycling") return "cycling";
    if (raw === "pedestrian") return "pedestrian";
    return "driving";
  };
  const eligibleStops = stops.filter((s) => {
    const status = String(s.delivery?.status || "");
    const isCyclingMarker = !!s.delivery?.is_cycling_marker;
    const isCyclingSegmentStop = cyclingSegmentOnly && resolveMode(s.delivery) === "cycling";
    return isPolylineEligibleStop({ status, isCyclingMarker, transportMode: null }) || isCyclingSegmentStop;
  });
  if (eligibleStops.length === 0) {
    console.log(`[routePolylineGenerator] ${source} \u2014 no eligible stops (en_route/in_transit) for polylines`);
    return polylineByDeliveryId;
  }
  const hasOrigin = originPoint && Number.isFinite(originPoint.lat) && Number.isFinite(originPoint.lon);
  const firstEligible = eligibleStops[0];
  const effectiveOrigin = hasOrigin ? { lat: originPoint.lat, lon: originPoint.lon } : { lat: firstEligible.lat, lon: firstEligible.lng };
  const stopsToPolyline = hasOrigin ? eligibleStops : eligibleStops.slice(1);
  const viaValid = !!(viaPointAfterOrigin && hasOrigin && Number.isFinite(Number(viaPointAfterOrigin.lat)) && Number.isFinite(Number(viaPointAfterOrigin.lon)));
  if (stopsToPolyline.length === 0) {
    console.log(`[routePolylineGenerator] ${source} \u2014 no coord-resolvable inbound legs, skipping polylines`);
    return polylineByDeliveryId;
  }
  let polyTargets = stopsToPolyline;
  if (forceRegenerate && polyTargets.length > 0) {
    console.log(`[routePolylineGenerator] ${source} \u2014 FORCE REGENERATE (${polyTargets.length} leg(s)) \u2014 full generation, leg-reuse skips bypassed`);
  }
  if (!forceRegenerate && orderUnchanged && polyTargets.length > 0) {
    const allLegsPresent = polyTargets.every(
      (s) => typeof s.delivery?.encoded_polyline === "string" && s.delivery.encoded_polyline.length > 10
    );
    if (!allLegsPresent) {
      console.log(`[routePolylineGenerator] ${source} \u2014 order unchanged but ${polyTargets.length - polyTargets.filter((s) => typeof s.delivery?.encoded_polyline === "string" && s.delivery.encoded_polyline.length > 10).length} leg(s) missing \u2192 full generation`);
    } else {
      const _anchorKm = (pts, anchor) => {
        if (!Array.isArray(pts) || pts.length === 0) return Infinity;
        if (!Number.isFinite(Number(pts[0][0])) || !Number.isFinite(Number(pts[0][1]))) return Infinity;
        const _latRad = (Number(anchor.lat) || 0) * Math.PI / 180;
        const _dLatKm = (Number(pts[0][0]) - Number(anchor.lat)) * 111.32;
        const _dLonKm = (Number(pts[0][1]) - Number(anchor.lon)) * 111.32 * Math.max(Math.cos(_latRad), 0.01);
        return Math.hypot(_dLatKm, _dLonKm);
      };
      let _staleLegIdx = -1;
      for (let i = 0; i < polyTargets.length; i++) {
        if (isLegOrderStampStale(polyTargets[i].delivery)) {
          console.log(`[routePolylineGenerator] ${source} \u2014 order unchanged but leg ${i + 1}/${polyTargets.length} stop_order stamp mismatch (manual reorder / unstamped) \u2192 full generation`);
          _staleLegIdx = i;
          break;
        }
        const expectedAnchor = i === 0 ? { lat: effectiveOrigin.lat, lon: effectiveOrigin.lon } : { lat: polyTargets[i - 1].lat, lon: polyTargets[i - 1].lng };
        let _km = Infinity;
        try {
          _km = _anchorKm(decodeGooglePolyline(polyTargets[i].delivery.encoded_polyline), expectedAnchor);
        } catch (_) {
        }
        if (!(_km < 0.15)) {
          _staleLegIdx = i;
          break;
        }
      }
      if (_staleLegIdx >= 0) {
        console.log(`[routePolylineGenerator] ${source} \u2014 order unchanged but stored leg ${_staleLegIdx + 1}/${polyTargets.length} is not anchored at its current predecessor (Start-renumber / adjacency change) \u2192 full generation`);
      } else if (viaValid) {
        console.log(`[routePolylineGenerator] ${source} \u2014 order unchanged, all legs anchored \u2192 current-leg-only regeneration (live-GPS via point); ${polyTargets.length - 1} later leg(s) keep existing polylines`);
        polyTargets = [polyTargets[0]];
      } else {
        console.log(`[routePolylineGenerator] ${source} \u2014 ORDER UNCHANGED, all ${polyTargets.length} leg(s) present and anchored \u2192 polyline generation SKIPPED (ETAs still update from HERE sequencing)`);
        return polylineByDeliveryId;
      }
    }
  }
  const modeGroups = [];
  for (let i = 0; i < polyTargets.length; i++) {
    const stop = polyTargets[i];
    const mode = resolveMode(stop.delivery);
    const prev = i === 0 ? effectiveOrigin : { lat: polyTargets[i - 1].lat, lon: polyTargets[i - 1].lng };
    const last = modeGroups[modeGroups.length - 1];
    if (last && last.mode === mode) {
      last.stops.push(stop);
    } else {
      modeGroups.push({ mode, fromPoint: { lat: prev.lat, lon: prev.lon }, stops: [stop] });
    }
  }
  console.log(`[routePolylineGenerator] ${source} \u2014 polyline mode groups: ${modeGroups.map((g) => `${g.mode}\xD7${g.stops.length}`).join(", ")}, origin=${hasOrigin ? "provided" : "first_stop"}`);
  const useGooglePoly = polylineProvider === "google" && polylineApiKey;
  const DEVIATION_WAYPOINT_CAP = 3;
  const getDeviationWaypoints = (delivery) => {
    const raw = Array.isArray(delivery?.deviation_waypoints) ? delivery.deviation_waypoints : [];
    return raw.filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))).sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || ""))).map((p) => ({ lat: Number(p.lat), lon: Number(p.lng) })).slice(-DEVIATION_WAYPOINT_CAP);
  };
  const groupResults = await Promise.all(modeGroups.map(async (group, groupIdx) => {
    const useVia = groupIdx === 0 && viaValid;
    const points = [{ lat: group.fromPoint.lat, lon: group.fromPoint.lon }];
    let liveViaIdx = -1;
    const stopIdxs = [];
    const stopViaCounts = [];
    group.stops.forEach((stop) => {
      const vias = getDeviationWaypoints(stop.delivery);
      vias.forEach((v) => points.push(v));
      stopViaCounts.push(vias.length);
      if (useVia && liveViaIdx === -1) {
        liveViaIdx = points.length;
        points.push({ lat: Number(viaPointAfterOrigin.lat), lon: Number(viaPointAfterOrigin.lon) });
      }
      stopIdxs.push(points.length);
      points.push({ lat: stop.lat, lon: stop.lng });
    });
    const viaTotal = stopViaCounts.reduce((s, n) => s + n, 0) + (liveViaIdx !== -1 ? 1 : 0);
    const result = useGooglePoly ? await getMultiStopRouteGoogle(points, group.mode, polylineApiKey, { driverId, userName, purpose: logPurpose }).catch((err) => {
      console.error(`[routePolylineGenerator] ${source} \u2014 Google Directions THREW (mode=${group.mode}), degrading to crow-flies:`, err?.message || err);
      return { sections: crowFliesSections(points, group.mode), usedFallbackPolyline: true };
    }) : await getMultiStopRouteHere(points, group.mode, hereApiKey, { driverId, userName, logPurpose }).catch((err) => {
      console.error(`[routePolylineGenerator] ${source} \u2014 HERE Router v8 THREW (mode=${group.mode}), degrading to crow-flies:`, err?.message || err);
      return { sections: crowFliesSections(points, group.mode), usedFallbackPolyline: true };
    });
    console.log(`[routePolylineGenerator] ${source} \u2014 ${useGooglePoly ? "Google" : "HERE"} ${group.mode} returned ${result.sections.length} sections for ${points.length} points${useVia ? " (incl. live-GPS via)" : ""}${viaTotal ? ` (incl. ${viaTotal} via point(s))` : ""}`);
    return { group, sections: result.sections || [], useVia, liveViaIdx, stopIdxs, stopViaCounts, points };
  }));
  for (const { group, sections, useVia, liveViaIdx, stopIdxs, stopViaCounts, points } of groupResults) {
    group.stops.forEach((stop, groupLocalIndex) => {
      const stopIdx = stopIdxs[groupLocalIndex];
      const viaCount = stopViaCounts[groupLocalIndex] || 0;
      const liveViaOnThisLeg = useVia && liveViaIdx !== -1 && groupLocalIndex === 0;
      const renderStart = liveViaOnThisLeg ? 0 : Math.max(0, stopIdx - 1 - viaCount);
      const metricsStart = liveViaOnThisLeg ? Math.max(1, stopIdx - 1) : Math.max(0, stopIdx - 1 - viaCount);
      const chainSections = sections.slice(renderStart, stopIdx).filter(Boolean);
      let encoded = null;
      if (chainSections.length === 1) {
        encoded = chainSections[0].encoded_polyline || null;
      } else if (chainSections.length > 1) {
        encoded = chainSections.reduce((acc, sec) => mergeGooglePolylines(acc, sec?.encoded_polyline || null), null);
      }
      const metricSections = sections.slice(metricsStart, stopIdx).filter(Boolean);
      let metricDuration = null;
      let metricDistance = null;
      if (metricSections.length === 1) {
        metricDuration = metricSections[0].estimated_duration_minutes ?? null;
        metricDistance = metricSections[0].estimated_distance_km ?? null;
      } else if (metricSections.length > 1) {
        metricDuration = metricSections.reduce((s, sec) => s + (Number(sec?.estimated_duration_minutes) || 0), 0);
        metricDistance = Number(metricSections.reduce((s, sec) => s + (Number(sec?.estimated_distance_km) || 0), 0).toFixed(3));
      }
      const _sameLeg = sameAnchorLeg(points[stopIdx - 1], points[stopIdx]);
      if (_sameLeg) {
        encoded = _sameLeg.encoded;
        metricDuration = _sameLeg.durationMinutes;
        metricDistance = _sameLeg.distanceKm;
      }
      const _winterDurationMinutes = _winterPad(metricDuration, group.mode);
      polylineByDeliveryId.set(stop.delivery.id, {
        encodedPolyline: encoded,
        estimatedDistanceKm: metricDistance,
        estimatedDurationMinutes: _winterDurationMinutes,
        transportMode: group.mode
      });
      if (directionsLegs && routeStops && _winterDurationMinutes && Number(_winterDurationMinutes) > 0) {
        const routeStopIdx = routeStops.findIndex((s) => s.delivery.id === stop.delivery.id);
        if (routeStopIdx !== -1) {
          directionsLegs[routeStopIdx] = {
            ...directionsLegs[routeStopIdx],
            duration: Number(_winterDurationMinutes) * 60,
            distance: metricDistance != null ? Number(metricDistance) * 1e3 : directionsLegs[routeStopIdx]?.distance
          };
        }
      }
    });
  }
  const _polyCount = [...polylineByDeliveryId.values()].filter((s) => s?.encodedPolyline != null).length;
  if (_polyCount === 0) {
    console.warn(`[routePolylineGenerator] ${source} \u2014 produced 0 polylines despite ${eligibleStops.length} eligible stop(s) and ${polyTargets.length} leg(s) \u2014 investigate origin/coords/HERE response`);
  } else {
    console.log(`[routePolylineGenerator] ${source} \u2014 polylines generated: ${_polyCount}/${polyTargets.length} legs`);
  }
  return polylineByDeliveryId;
}

// src/components/utils/geoUtils.js
var EARTH_RADIUS_KM2 = 6371;
var haversineKm2 = (lat1, lon1, lat2, lon2) => {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM2 * c;
};

// src/components/utils/clientRouteEngine.js
var FINISHED_STATUSES = ["completed", "failed", "cancelled"];
var ACTIVE_STATUSES = ["in_transit", "en_route"];
var TIME_ZONE = "America/Edmonton";
var WEEKDAY_CODES = ["su", "mo", "tu", "we", "th", "fr", "sa"];
async function logHereApiCall2({ apiType, purpose, source, driverId, userName, callCount = 1 }) {
  try {
    await base44.entities.GoogleAPILog.create({
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      api_type: apiType,
      purpose: purpose || apiType,
      function_name: source || "clientRouteEngine",
      user_id: driverId || null,
      user_name: userName || null,
      metadata: {
        provider: "HERE",
        source: source || "client",
        call_count: callCount
      }
    });
  } catch {
  }
}
var calculateCrowFliesDistance2 = (lat1, lng1, lat2, lng2) => haversineKm2(lat1, lng1, lat2, lng2);
var normalizeTimeString = (timeStr, fallback = "00:00:00") => {
  if (!timeStr || typeof timeStr !== "string") return fallback;
  const parts = timeStr.split(":");
  if (parts.length < 2) return fallback;
  return `${String(Number(parts[0]) || 0).padStart(2, "0")}:${String(Number(parts[1]) || 0).padStart(2, "0")}:${String(Number(parts[2]) || 0).padStart(2, "0")}`;
};
var getEffectiveWindowStart = (delivery, patient = null) => {
  const ownStart = delivery?.delivery_time_start || delivery?.time_window_start || null;
  if (ownStart) return ownStart;
  return patient?.time_window_start || null;
};
var getEffectiveWindowEnd = (delivery, patient = null) => {
  const ownEnd = delivery?.delivery_time_end || delivery?.time_window_end || null;
  if (ownEnd) return ownEnd;
  return patient?.time_window_end || null;
};
var isLateWindowStop = (windowStart, currentMinutes) => {
  const startMinutes = parseTimeToMinutes(windowStart);
  return Number.isFinite(startMinutes) && startMinutes > currentMinutes;
};
var getWeekdayCode = (dateStr) => {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  return WEEKDAY_CODES[utcDate.getUTCDay()];
};
var getTimeZoneOffset = (dateStr) => {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const sampleDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  const tzName = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    timeZoneName: "shortOffset",
    hour: "2-digit"
  }).formatToParts(sampleDate).find((part) => part.type === "timeZoneName")?.value || "GMT-07:00";
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return "-07:00";
  return `${match[1]}${String(match[2]).padStart(2, "0")}:${String(match[3] || "00").padStart(2, "0")}`;
};
var buildLocalIso = (dateStr, timeStr) => `${dateStr}T${normalizeTimeString(timeStr)}${getTimeZoneOffset(dateStr)}`;
var buildAccessConstraint = (dateStr, startTime, endTime) => {
  if (!startTime && !endTime) return null;
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);
  if (Number.isFinite(startMinutes) && Number.isFinite(endMinutes) && endMinutes <= startMinutes) return null;
  const weekday = getWeekdayCode(dateStr);
  const offset = getTimeZoneOffset(dateStr);
  const start = normalizeTimeString(startTime, "00:00:00");
  const end = normalizeTimeString(endTime, "23:59:59");
  return `acc:${weekday}${start}${offset}|${weekday}${end}${offset}`;
};
var getEdmontonTodayDateString = () => {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(/* @__PURE__ */ new Date());
};
var isHistoricalRouteDate = (dateStr) => {
  if (!dateStr) return false;
  return String(dateStr) < getEdmontonTodayDateString();
};
var getLatestFinishedDelivery = (deliveries) => [...deliveries || []].filter((d) => FINISHED_STATUSES.includes(d?.status)).sort((a, b) => {
  const aTime = new Date(a?.actual_delivery_time || a?.updated_date || a?.created_date || 0).getTime();
  const bTime = new Date(b?.actual_delivery_time || b?.updated_date || b?.created_date || 0).getTime();
  return bTime - aTime;
})[0] || null;
var getDeliveryCoords = (delivery, patientMap, storeMap) => {
  if (!delivery) return null;
  if (delivery.is_cycling_marker) {
    const lat = Number(delivery.cycling_latitude);
    const lng = Number(delivery.cycling_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) return { lat, lng };
    return null;
  }
  if (!delivery.patient_id && isInterStoreDelivery(delivery.delivery_id)) {
    const loc = getInterStoreLocationSync(delivery.delivery_id);
    const lat = Number(loc?.store_latitude);
    const lng = Number(loc?.store_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) return { lat, lng };
  }
  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    if (patient?.latitude != null && patient?.longitude != null) return { lat: Number(patient.latitude), lng: Number(patient.longitude) };
  }
  const store = storeMap.get(delivery.store_id);
  if (store?.latitude != null && store?.longitude != null) return { lat: Number(store.latitude), lng: Number(store.longitude) };
  return null;
};
async function callHereSequence({ sequenceStart, stopsToSequence, resolvedHomePosition, hereApiKey, hereTransportMode, deliveryDate, currentLocalTime, currentMinutes, includeTimeWindows, driverId = null, userName = null }) {
  const params = new URLSearchParams();
  params.set("apiKey", hereApiKey);
  params.set("departure", buildLocalIso(deliveryDate, currentLocalTime || formatMinutesToTime(currentMinutes)));
  params.set("mode", `fastest;${hereTransportMode};traffic:disabled`);
  params.set("improveFor", "time");
  params.set("start", `driverStart;${sequenceStart.lat},${sequenceStart.lng}`);
  if (resolvedHomePosition) {
    params.set("end", `driverHome;${resolvedHomePosition.lat},${resolvedHomePosition.lng}`);
  }
  stopsToSequence.forEach((stop, index) => {
    const segments = [`${stop.delivery.stop_id || stop.delivery.delivery_id || stop.delivery.id};${stop.lat},${stop.lng}`];
    if (includeTimeWindows) {
      const wsMin = parseTimeToMinutes(stop.windowStart);
      const windowAlreadyOpen = Number.isFinite(wsMin) && wsMin > 0 && deliveryDate === getEdmontonTodayDateString() && wsMin <= currentMinutes;
      const accessConstraint = buildAccessConstraint(deliveryDate, windowAlreadyOpen ? null : stop.windowStart, stop.windowEnd);
      if (accessConstraint) segments.push(accessConstraint);
    }
    segments.push(`st:${Math.round((stop.delivery.extra_time || (stop.isPickup ? 15 : 5)) * 60)}`);
    params.set(`destination${index + 1}`, segments.join(";"));
  });
  const response = await fetch(`https://wps.hereapi.com/v8/findsequence2?${params.toString()}`, {
    signal: AbortSignal.timeout(25e3)
  });
  console.log(`\u{1F310} [HERE findsequence2] URL params:`, Object.fromEntries(params.entries()));
  logHereApiCall2({ apiType: "Route Optimization (HERE)", purpose: `findsequence2 \u2014 ${stopsToSequence.length} stop(s), mode=${hereTransportMode}`, source: "callHereSequence", driverId, userName }).catch(() => {
  });
  const data = await response.json().catch(() => null);
  return { response, data, includeTimeWindows };
}
async function optimizeRouteClientSide({
  deliveries,
  patients = [],
  stores = [],
  appUsers = [],
  driverId,
  deliveryDate,
  hereApiKey,
  currentLocation = null,
  source = "client_engine",
  preserveExistingOrder = false,
  forceRegenerate = false,
  // OWNER REQUEST (Oct 15 2026): Quick Route Adjustments
  // Regenerate — ALL remaining stops must get fresh polylines
  // even when no stop changed order. Bypasses every
  // order-unchanged / leg-reuse skip downstream.
  cyclingSegmentOnly = false,
  cyclingOrigin = null,
  cyclingDestination = null,
  cyclingStopIds = [],
  drivingSegmentOnly = false,
  drivingOrigin = null,
  excludeStopIds = [],
  startingStopOrder = null,
  polylineProvider = "here",
  polylineApiKey = null,
  clearNextDeliveryLock = false,
  includePendingPolylines = false
}) {
  if (!driverId || !deliveryDate) {
    return { success: false, error: "Missing driverId or deliveryDate" };
  }
  if (!hereApiKey) {
    return { success: false, error: "Missing HERE API key" };
  }
  const allDeliveries = deliveries || [];
  if (allDeliveries.length === 0) {
    return { success: true, routeChanged: false, optimizedCount: 0, orderedDeliveryIds: [], optimizedRoute: [], writeBatch: [] };
  }
  const patientMap = new Map((patients || []).map((p) => [p.id, p]));
  const storeMap = new Map((stores || []).map((s) => [s.id, s]));
  let driverAppUser = (appUsers || []).find((au) => au?.user_id === driverId || au?.id === driverId) || null;
  if (!driverAppUser) {
    console.warn(`[clientRouteEngine] ${source} \u2014 driver AppUser NOT FOUND in appUsers (array size=${(appUsers || []).length}, driverId=${driverId}). Fetching from DB...`);
    try {
      const dbResults = await Promise.race([
        base44.entities.AppUser.filter({ user_id: driverId }).catch(() => []),
        new Promise((res) => setTimeout(() => {
          console.warn(`[clientRouteEngine] ${source} \u2014 DB fallback for AppUser capped at 8s (pool hot?) \u2014 proceeding with defaults`);
          res([]);
        }, 8e3))
      ]);
      if (Array.isArray(dbResults) && dbResults.length > 0) {
        driverAppUser = dbResults[0];
        console.log(`[clientRouteEngine] ${source} \u2014 driver AppUser found via DB fallback: user_id=${driverAppUser.user_id}, gps=${driverAppUser.current_latitude ?? "null"},${driverAppUser.current_longitude ?? "null"}, home=${driverAppUser.home_latitude ?? "null"},${driverAppUser.home_longitude ?? "null"}`);
      } else {
        console.warn(`[clientRouteEngine] ${source} \u2014 driver AppUser NOT in DB either. Proceeding with defaults \u2014 will use stop coords as origin fallback.`);
      }
    } catch (err) {
      console.warn(`[clientRouteEngine] ${source} \u2014 DB fallback for AppUser failed:`, err?.message || err);
    }
  } else {
    console.log(`[clientRouteEngine] ${source} \u2014 driver AppUser found locally: user_id=${driverAppUser.user_id}, gps=${driverAppUser.current_latitude ?? "null"},${driverAppUser.current_longitude ?? "null"}, home=${driverAppUser.home_latitude ?? "null"},${driverAppUser.home_longitude ?? "null"}, travelMode=${driverAppUser.preferred_travel_mode || "default"}`);
  }
  const _driverAppUser = driverAppUser || {};
  const _driverUserName = _driverAppUser?.user_name || null;
  const preferredTravelMode = String(_driverAppUser?.preferred_travel_mode || "driving").toLowerCase();
  const effectiveTravelMode = preferredTravelMode === "cycling" ? "driving" : preferredTravelMode;
  const hereTransportMode = effectiveTravelMode === "pedestrian" ? "pedestrian" : "car";
  const cyclingHereMode = cyclingSegmentOnly ? "bicycle" : hereTransportMode;
  const now = /* @__PURE__ */ new Date();
  const edmontonFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const edmontonParts = edmontonFormatter.formatToParts(now);
  const edmontonHour = parseInt(edmontonParts.find((p) => p.type === "hour")?.value || "0", 10);
  const edmontonMinute = parseInt(edmontonParts.find((p) => p.type === "minute")?.value || "0", 10);
  let currentMinutes = edmontonHour * 60 + edmontonMinute;
  const currentLocalTime = `${String(edmontonHour).padStart(2, "0")}:${String(edmontonMinute).padStart(2, "0")}`;
  const driverDeliveries = allDeliveries.filter(
    (d) => d && String(d.driver_id) === String(driverId) && d.delivery_date === deliveryDate
  );
  console.log(`[clientRouteEngine] ${source} \u2014 allDeliveries=${allDeliveries.length}, after driver/date filter=${driverDeliveries.length} (driverId=${driverId}, date=${deliveryDate})`);
  const completedDeliveries = driverDeliveries.filter((d) => FINISHED_STATUSES.includes(d.status));
  const incompleteDeliveries = driverDeliveries.filter((d) => !FINISHED_STATUSES.includes(d.status));
  const activeRouteDeliveries = incompleteDeliveries.filter((d) => ACTIVE_STATUSES.includes(d.status));
  const pendingRouteDeliveries = incompleteDeliveries.filter((d) => d.status === "pending");
  const filteredPendingRouteDeliveries = pendingRouteDeliveries;
  const cyclingMarkers = incompleteDeliveries.filter((d) => d.is_cycling_marker);
  let optimizableDeliveries = [...activeRouteDeliveries, ...filteredPendingRouteDeliveries];
  if (cyclingSegmentOnly && cyclingStopIds.length > 0) {
    optimizableDeliveries = optimizableDeliveries.filter((d) => cyclingStopIds.includes(d.id));
  } else if (drivingSegmentOnly && excludeStopIds.length > 0) {
    optimizableDeliveries = optimizableDeliveries.filter((d) => !excludeStopIds.includes(d.id) && !d.is_cycling_marker);
  }
  if (optimizableDeliveries.length === 0) {
    console.warn(`[clientRouteEngine] ${source} \u2014 no optimizable deliveries (completed=${completedDeliveries.length}, active=${activeRouteDeliveries.length}, pending=${pendingRouteDeliveries.length})`);
    return { success: true, routeChanged: false, optimizedCount: 0, orderedDeliveryIds: [], optimizedRoute: [], writeBatch: [] };
  }
  console.log(`[clientRouteEngine] ${source} \u2014 INPUT: ${allDeliveries.length} total deliveries \u2192 completed=${completedDeliveries.length}, active=${activeRouteDeliveries.length}, pending=${pendingRouteDeliveries.length}, optimizable=${optimizableDeliveries.length}`);
  const pickupWindowByStopId = new Map(
    optimizableDeliveries.filter((d) => d && !d.patient_id && d.stop_id).map((d) => [d.stop_id, { start: d.delivery_time_start || null, end: d.delivery_time_end || null }])
  );
  const routeIsToday = deliveryDate === getEdmontonTodayDateString();
  let _clampedWindowCount = 0;
  let _inheritedWindowCount = 0;
  const stops = optimizableDeliveries.map((delivery) => {
    const coords = getDeliveryCoords(delivery, patientMap, storeMap);
    const patient = delivery.patient_id ? patientMap.get(delivery.patient_id) : null;
    let windowStart = getEffectiveWindowStart(delivery, patient);
    let windowEnd = getEffectiveWindowEnd(delivery, patient);
    if (delivery.patient_id && delivery.puid && pickupWindowByStopId.has(delivery.puid)) {
      const _ownStartMin = parseTimeToMinutes(windowStart);
      if (!Number.isFinite(_ownStartMin)) {
        const pickupWindow = pickupWindowByStopId.get(delivery.puid);
        const _inherited = inheritedPickupWindowStart(pickupWindow?.start || pickupWindow?.end);
        if (_inherited) {
          windowStart = _inherited;
          _inheritedWindowCount++;
        }
      }
    }
    if (routeIsToday && windowStart) {
      const _wsMin = parseTimeToMinutes(windowStart);
      if (Number.isFinite(_wsMin) && _wsMin < currentMinutes) {
        windowStart = formatMinutesToTime(currentMinutes);
        _clampedWindowCount++;
        if (windowEnd) {
          const _weMin = parseTimeToMinutes(windowEnd);
          if (!Number.isFinite(_weMin) || _weMin <= currentMinutes) windowEnd = null;
        }
      }
    }
    return {
      delivery,
      lat: coords?.lat,
      lng: coords?.lng,
      isPickup: !delivery.patient_id,
      windowStart,
      windowEnd,
      hasLateWindow: isLateWindowStop(windowStart, currentMinutes),
      timeMinutes: parseTimeToMinutes(windowStart || delivery.delivery_time_start)
    };
  }).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  const _droppedStops = optimizableDeliveries.length - stops.length;
  if (_droppedStops > 0) {
    console.warn(`[clientRouteEngine] ${source} \u2014 ${_droppedStops} stops DROPPED (missing coords). storeMap size=${storeMap.size}, patientMap size=${patientMap.size}`);
    const dropped = optimizableDeliveries.filter((d) => {
      const c = getDeliveryCoords(d, patientMap, storeMap);
      return !c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng);
    });
    dropped.forEach((d) => console.warn(`  \u2514\u2500 dropped delivery ${d.id} store_id=${d.store_id} patient_id=${d.patient_id || "N/A"}`));
  } else {
    console.log(`[clientRouteEngine] ${source} \u2014 ${stops.length} stops resolved with valid coords`);
  }
  if (_clampedWindowCount > 0) {
    console.log(`[clientRouteEngine] ${source} \u2014 PAST-WINDOW CLAMP: ${_clampedWindowCount} stale window(s) (start <= now) clamped to now (${formatMinutesToTime(currentMinutes)}) for geographic sequencing`);
  }
  if (_inheritedWindowCount > 0) {
    console.log(`[clientRouteEngine] ${source} \u2014 PICKUP-WINDOW INHERITANCE: ${_inheritedWindowCount} windowless delivery(ies) inherited pickup start+5`);
  }
  const historicalRoute = isHistoricalRouteDate(deliveryDate);
  const _todayStr = getEdmontonTodayDateString();
  const _isPreStartToday = deliveryDate === _todayStr && currentMinutes < 9 * 60;
  const isFutureRoute = !historicalRoute && (deliveryDate > _todayStr || _isPreStartToday);
  const routeOfficiallyStarted = completedDeliveries.length > 0;
  if (isFutureRoute && !routeOfficiallyStarted && !preserveExistingOrder && !cyclingSegmentOnly && !drivingSegmentOnly && cyclingMarkers.length === 0) {
    const driverHomeLocation = _driverAppUser?.home_latitude != null && _driverAppUser?.home_longitude != null ? { lat: Number(_driverAppUser.home_latitude), lon: Number(_driverAppUser.home_longitude) } : null;
    console.log(`[clientRouteEngine] ${source} \u2014 FUTURE route: skipping HERE sequence optimizer, sorting by delivery_time_start, generating planned polylines (origin=${driverHomeLocation ? "driver_home" : "first_pickup_fallback"})`);
    return await _handleFutureRoute({
      optimizableDeliveries,
      storeMap,
      patientMap,
      deliveryDate,
      startingStopOrder,
      completedDeliveries,
      currentMinutes,
      source,
      hereApiKey,
      polylineProvider,
      polylineApiKey,
      driverHomeLocation,
      driverId,
      userName: _driverUserName,
      effectiveTravelMode
    });
  }
  const latestFinishedDelivery = getLatestFinishedDelivery(completedDeliveries);
  const explicitNextDelivery = incompleteDeliveries.find((d) => d?.isNextDelivery === true) || null;
  const latestFinishedCoords = latestFinishedDelivery ? getDeliveryCoords(latestFinishedDelivery, patientMap, storeMap) : null;
  console.log(`[clientRouteEngine] ${source} \u2014 home=${_driverAppUser.home_latitude != null ? `(${_driverAppUser.home_latitude},${_driverAppUser.home_longitude})` : "null"}, travelMode=${preferredTravelMode}`);
  let currentPosition = null;
  let locationSource = null;
  if (latestFinishedCoords) {
    currentPosition = latestFinishedCoords;
    locationSource = "last_finished_stop";
  } else if (_driverAppUser.home_latitude != null && _driverAppUser.home_longitude != null) {
    currentPosition = { lat: Number(_driverAppUser.home_latitude), lng: Number(_driverAppUser.home_longitude) };
    locationSource = "home";
  }
  if (cyclingSegmentOnly && cyclingOrigin?.lat != null && (cyclingOrigin?.lon ?? cyclingOrigin?.lng) != null) {
    currentPosition = { lat: Number(cyclingOrigin.lat), lng: Number(cyclingOrigin.lon ?? cyclingOrigin.lng) };
    locationSource = "cycling_origin_override";
  }
  if (drivingSegmentOnly && drivingOrigin?.lat != null && (drivingOrigin?.lon ?? drivingOrigin?.lng) != null) {
    currentPosition = { lat: Number(drivingOrigin.lat), lng: Number(drivingOrigin.lon ?? drivingOrigin.lng) };
    locationSource = "driving_origin_override";
  }
  if (!currentPosition) {
    console.error(`[clientRouteEngine] ${source} \u2014 ABORT: no polyline origin available (no completed stop, no home location set)`);
    return { success: false, error: "No polyline origin available \u2014 set a home location or complete a stop first" };
  }
  console.log(`[clientRouteEngine] ${source} \u2014 currentPosition=(${currentPosition.lat.toFixed(4)}, ${currentPosition.lng.toFixed(4)}) source=${locationSource}`);
  const resolvedHomePosition = _driverAppUser.home_latitude != null && _driverAppUser.home_longitude != null ? { lat: Number(_driverAppUser.home_latitude), lng: Number(_driverAppUser.home_longitude) } : null;
  const optimizationStops = optimizableDeliveries.map((d) => stops.find((item) => item.delivery.id === d.id) || null).filter(Boolean);
  const orderedOptimizationStops = preserveExistingOrder ? optimizationStops.slice().sort((a, b) => (Number(a.delivery?.stop_order) || 99999) - (Number(b.delivery?.stop_order) || 99999)) : optimizationStops;
  const explicitNextStop = orderedOptimizationStops.find((s) => s.delivery.isNextDelivery === true) || null;
  const explicitNextIsActive = explicitNextStop && ACTIVE_STATUSES.includes(explicitNextStop.delivery.status);
  const implicitNextStop = !explicitNextStop ? orderedOptimizationStops.find((s) => ACTIVE_STATUSES.includes(s.delivery.status)) || null : null;
  const lockedNextStop = !preserveExistingOrder && !clearNextDeliveryLock ? explicitNextIsActive ? explicitNextStop : implicitNextStop || null : null;
  const routeOriginStop = lockedNextStop || null;
  const stopsToSequence = routeOriginStop ? orderedOptimizationStops.filter((s) => s.delivery.id !== routeOriginStop.delivery.id) : orderedOptimizationStops;
  console.log(`[clientRouteEngine] ${source} \u2014 isNextDelivery lock: explicit=${explicitNextStop?.delivery.id || "none"}(active=${explicitNextIsActive}), implicit=${implicitNextStop?.delivery.id || "none"}, locked=${lockedNextStop?.delivery.id || "none"}`);
  let usedTimeWindows = true;
  let usedFallbackOrdering = false;
  let routeStops = routeOriginStop ? [routeOriginStop] : [];
  let directionsLegs = [];
  let segmentPolylines = [];
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("routeOptimizationPhase", { detail: { phase: "optimizing", source, driverId, deliveryDate } }));
  }
  const runHereSequence = async ({ sequenceStart, stops: seqStops, origin, hereMode, withHome, destination }) => {
    if (seqStops.length === 0) return { orderedStops: [], legs: [] };
    let attempt = await callHereSequence({
      sequenceStart,
      stopsToSequence: seqStops,
      resolvedHomePosition: destination || (withHome ? resolvedHomePosition : null),
      hereApiKey,
      hereTransportMode: hereMode,
      deliveryDate,
      currentLocalTime,
      currentMinutes,
      includeTimeWindows: true,
      driverId,
      userName: _driverUserName
    });
    let result = Array.isArray(attempt.data?.results) ? attempt.data.results[0] : null;
    let waypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
    let interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];
    if ((!attempt.response.ok || !result || waypoints.length === 0) && attempt.includeTimeWindows) {
      console.warn(`\u26A0\uFE0F [clientRouteEngine] ${source} \u2014 HERE time-window attempt FAILED (status=${attempt.response.status}), retrying WITHOUT time windows`);
      usedTimeWindows = false;
      attempt = await callHereSequence({
        sequenceStart,
        stopsToSequence: seqStops,
        resolvedHomePosition: destination || (withHome ? resolvedHomePosition : null),
        hereApiKey,
        hereTransportMode: hereMode,
        deliveryDate,
        currentLocalTime,
        currentMinutes,
        includeTimeWindows: false,
        driverId,
        userName: _driverUserName
      });
      result = Array.isArray(attempt.data?.results) ? attempt.data.results[0] : null;
      waypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
      interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];
    } else {
      console.log(`\u2705 [clientRouteEngine] ${source} \u2014 HERE sequencing ${usedTimeWindows ? "WITH time windows" : "WITHOUT time windows"} (status=${attempt.response.status}, ${waypoints.length} waypoints)`);
    }
    if (!attempt.response.ok || !result || waypoints.length === 0) {
      console.warn(`[clientRouteEngine] ${source} \u2014 HERE sequencing FAILED (mode=${hereMode}, status=${attempt.response.status}), crow-flies fallback`);
      usedFallbackOrdering = true;
      const sorted = [...seqStops].sort((a, b) => {
        const distA = calculateCrowFliesDistance2(origin.lat, origin.lng, a.lat, a.lng);
        const distB = calculateCrowFliesDistance2(origin.lat, origin.lng, b.lat, b.lng);
        const penA = resolvedHomePosition && withHome ? calculateCrowFliesDistance2(a.lat, a.lng, resolvedHomePosition.lat, resolvedHomePosition.lng) : 0;
        const penB = resolvedHomePosition && withHome ? calculateCrowFliesDistance2(b.lat, b.lng, resolvedHomePosition.lat, resolvedHomePosition.lng) : 0;
        return distA - penA * 0.15 - (distB - penB * 0.15);
      });
      let prev = origin;
      const legs2 = sorted.map((s) => {
        const d = calculateCrowFliesDistance2(prev.lat, prev.lng, s.lat, s.lng);
        prev = { lat: s.lat, lng: s.lng };
        return { duration: Math.ceil(d / 40 * 60 * 60 * 1.3), distance: d * 1e3 };
      });
      return { orderedStops: sorted, legs: legs2 };
    }
    console.log(`[clientRouteEngine] ${source} \u2014 HERE sequencing OK (mode=${hereMode}): ${waypoints.length} waypoints`);
    const _seqOrder = waypoints.filter((wp) => wp.id !== "driverStart" && wp.id !== "driverEnd").sort((a, b) => (a.sequence || 0) - (b.sequence || 0)).map((wp) => wp.id);
    const _existingOrder = seqStops.map((s) => s.delivery.stop_id || s.delivery.delivery_id || s.delivery.id);
    const _orderChanged = _seqOrder.length === _existingOrder.length && _seqOrder.some((id, i) => id !== _existingOrder[i]);
    console.log(`[clientRouteEngine] ${source} \u2014 HERE seq order: [${_seqOrder.join(",")}] vs existing: [${_existingOrder.join(",")}] changed=${_orderChanged}`);
    const ordered = waypoints.filter((wp) => wp.id !== "driverStart" && wp.id !== "driverEnd").sort((a, b) => (a.sequence || 0) - (b.sequence || 0)).map((wp) => ({
      stop: seqStops.find((s) => (s.delivery.stop_id || s.delivery.delivery_id || s.delivery.id) === wp.id) || null,
      waypoint: wp
    })).filter((item) => item.stop);
    const icByTo = new Map(interconnections.map((i) => [i.toWaypoint, i]));
    const legs = ordered.map((item, idx) => {
      const ic = icByTo.get(item.waypoint.id);
      if (idx === 0) {
        const d = calculateCrowFliesDistance2(origin.lat, origin.lng, item.stop.lat, item.stop.lng);
        return ic ? { duration: Number(ic.time || 0), distance: Number(ic.distance || 0) } : { duration: Math.ceil(d / 40 * 60 * 60 * 1.3), distance: d * 1e3 };
      }
      return { duration: Number(ic?.time || 0), distance: Number(ic?.distance || 0) };
    });
    return { orderedStops: ordered.map((i) => i.stop), legs };
  };
  if (preserveExistingOrder) {
    routeStops = [...orderedOptimizationStops];
    let prevPos = currentPosition;
    for (const stop of routeStops) {
      const distKm = calculateCrowFliesDistance2(prevPos.lat, prevPos.lng, stop.lat, stop.lng);
      directionsLegs.push({ duration: Math.ceil(distKm / 40 * 60 * 60 * 1.3), distance: distKm * 1e3 });
      prevPos = { lat: stop.lat, lng: stop.lng };
    }
  } else if (stopsToSequence.length > 0) {
    console.log(`[clientRouteEngine] ${source} \u2014 calling HERE findsequence2 for ${stopsToSequence.length} stops`);
    const startMarker = orderedOptimizationStops.find(
      (s) => s.delivery.is_cycling_marker && (s.delivery.delivery_notes || "").toLowerCase().includes("start")
    ) || null;
    const endMarker = orderedOptimizationStops.find(
      (s) => s.delivery.is_cycling_marker && (s.delivery.delivery_notes || "").toLowerCase().includes("end")
    ) || null;
    const hasCyclingSegment = !!endMarker;
    if (hasCyclingSegment) {
      const drivingPool = stopsToSequence.filter(
        (s) => !s.delivery.is_cycling_marker && String(s.delivery.transport_mode || "driving").toLowerCase() !== "cycling"
      );
      const cyclingPool = stopsToSequence.filter(
        (s) => !s.delivery.is_cycling_marker && String(s.delivery.transport_mode || "").toLowerCase() === "cycling"
      );
      console.log(`[clientRouteEngine] ${source} \u2014 mixed-mode sequencing: ${drivingPool.length} driving, ${cyclingPool.length} cycling, 2 markers`);
      const cyclingLegOrigin = routeOriginStop ? { lat: routeOriginStop.lat, lng: routeOriginStop.lng } : currentPosition;
      const cyclingDest = { lat: endMarker.lat, lng: endMarker.lng };
      const { orderedStops: orderedCycling, legs: cyclingLegs } = await runHereSequence({
        sequenceStart: cyclingLegOrigin,
        stops: cyclingPool,
        origin: cyclingLegOrigin,
        hereMode: "bicycle",
        destination: cyclingDest
      });
      const drivingLegOrigin = { lat: endMarker.lat, lng: endMarker.lng };
      const { orderedStops: orderedDriving, legs: drivingLegs } = await runHereSequence({
        sequenceStart: drivingLegOrigin,
        stops: drivingPool,
        origin: drivingLegOrigin,
        hereMode: "car",
        withHome: true
      });
      const isRouteOriginStart = routeOriginStop && startMarker && routeOriginStop.delivery.id === startMarker.delivery.id;
      const stitchedStops = [
        ...routeOriginStop ? [routeOriginStop] : [],
        ...startMarker && !isRouteOriginStart ? [startMarker] : [],
        ...orderedCycling,
        endMarker,
        ...orderedDriving
      ];
      const stitchedLegs = [];
      let legCursor = currentPosition;
      for (const stop of stitchedStops) {
        const isLockedNext = routeOriginStop && stop.delivery.id === routeOriginStop.delivery.id;
        const isStart = !isLockedNext && startMarker && stop.delivery.id === startMarker.delivery.id;
        const isEnd = endMarker && stop.delivery.id === endMarker.delivery.id;
        const isCyclingStop = orderedCycling.includes(stop);
        const isDrivingStop = orderedDriving.includes(stop);
        if (isLockedNext) {
          const d = calculateCrowFliesDistance2(legCursor.lat, legCursor.lng, stop.lat, stop.lng);
          stitchedLegs.push({ duration: Math.ceil(d / 40 * 60 * 60 * 1.3), distance: d * 1e3 });
        } else if (isStart) {
          const d = calculateCrowFliesDistance2(legCursor.lat, legCursor.lng, stop.lat, stop.lng);
          stitchedLegs.push({ duration: Math.ceil(d / 40 * 60 * 60 * 1.3), distance: d * 1e3 });
        } else if (isCyclingStop) {
          const idx = orderedCycling.indexOf(stop);
          stitchedLegs.push(cyclingLegs[idx] || { duration: 0, distance: 0 });
        } else if (isEnd) {
          const d = calculateCrowFliesDistance2(legCursor.lat, legCursor.lng, stop.lat, stop.lng);
          stitchedLegs.push({ duration: Math.ceil(d / 20 * 60 * 60 * 1.2), distance: d * 1e3 });
        } else if (isDrivingStop) {
          const idx = orderedDriving.indexOf(stop);
          stitchedLegs.push(drivingLegs[idx] || { duration: 0, distance: 0 });
        }
        legCursor = { lat: stop.lat, lng: stop.lng };
      }
      routeStops = stitchedStops;
      directionsLegs = stitchedLegs;
    } else {
      const seqOrigin = routeOriginStop ? { lat: routeOriginStop.lat, lng: routeOriginStop.lng } : currentPosition;
      const hereMode = cyclingSegmentOnly ? cyclingHereMode : hereTransportMode;
      const hasTimeWindows2 = stopsToSequence.some(
        (s) => s.windowStart && parseTimeToMinutes(s.windowStart) > 0
      );
      const { orderedStops, legs } = await runHereSequence({
        sequenceStart: seqOrigin,
        stops: stopsToSequence,
        origin: seqOrigin,
        hereMode,
        withHome: true
      });
      let finalStops = orderedStops;
      let finalLegs = legs;
      if (hasTimeWindows2 && orderedStops.length > 1) {
        const TIME_BAND_MINUTES2 = 120;
        const _sharedBandOpts = {
          routeIsToday,
          currentMinutes,
          windowOf: (st) => st?.windowStart || st?.delivery?.delivery_time_start || ""
        };
        const bandOf = (stop) => windowBandOfStop(stop, _sharedBandOpts);
        finalStops = windowBandSort(orderedStops, _sharedBandOpts);
        const hereOrder = new Map(orderedStops.map((stop, i) => [stop, i]));
        const reordered = finalStops.some((stop, i) => finalStops[i] !== orderedStops[i]);
        console.log(`[clientRouteEngine] ${source} \u2014 window-band enforcement: ${reordered ? "reordered HERE sequence" : "HERE order already window-compliant"} (${finalStops.length} stops, ${new Set(finalStops.map(bandOf)).size} band(s))`);
        finalLegs = finalStops.map((stop, j) => {
          const hereIdx = hereOrder.get(stop);
          const prevStop = j > 0 ? finalStops[j - 1] : null;
          const prevHereIdx = prevStop ? hereOrder.get(prevStop) : null;
          if (j === 0 && hereIdx === 0 && legs[0]) return legs[0];
          if (j > 0 && hereIdx !== void 0 && prevHereIdx === hereIdx - 1 && legs[hereIdx]) {
            return legs[hereIdx];
          }
          const fromLat = prevStop ? prevStop.lat : seqOrigin.lat;
          const fromLng = prevStop ? prevStop.lng : seqOrigin.lng;
          const d = calculateCrowFliesDistance2(fromLat, fromLng, stop.lat, stop.lng);
          return { duration: Math.ceil(d / 40 * 60 * 60 * 1.3), distance: d * 1e3 };
        });
      }
      routeStops = [...routeStops, ...finalStops];
      directionsLegs = routeOriginStop ? [
        (() => {
          const d = calculateCrowFliesDistance2(currentPosition.lat, currentPosition.lng, routeOriginStop.lat, routeOriginStop.lng);
          return { duration: Math.ceil(d / 40 * 60 * 60 * 1.3), distance: d * 1e3 };
        })(),
        ...finalLegs
      ] : finalLegs;
    }
  }
  if (cyclingMarkers.length > 0) {
    for (const marker of cyclingMarkers) {
      const notes = (marker.delivery_notes || "").toLowerCase();
      const isEndMarker = notes.includes("end");
      const markerIdx = routeStops.findIndex((s) => s.delivery.id === marker.id);
      if (markerIdx === -1) continue;
      if (!isEndMarker) {
        const firstCyclingIdx = routeStops.findIndex(
          (s) => s.delivery.transport_mode === "cycling" && !s.delivery.is_cycling_marker
        );
        if (firstCyclingIdx !== -1 && markerIdx > firstCyclingIdx) {
          const [removed] = routeStops.splice(markerIdx, 1);
          const newFirstCyclingIdx = routeStops.findIndex(
            (s) => s.delivery.transport_mode === "cycling" && !s.delivery.is_cycling_marker
          );
          routeStops.splice(Math.max(0, newFirstCyclingIdx), 0, removed);
          console.log(`[clientRouteEngine] ${source} \u2014 repositioned cycling START marker before cycling stops`);
        }
      } else {
        let lastCyclingIdx = -1;
        for (let ri = 0; ri < routeStops.length; ri++) {
          if (routeStops[ri].delivery.transport_mode === "cycling" && !routeStops[ri].delivery.is_cycling_marker) {
            lastCyclingIdx = ri;
          }
        }
        const currentMarkerIdx = routeStops.findIndex((s) => s.delivery.id === marker.id);
        if (lastCyclingIdx !== -1 && currentMarkerIdx < lastCyclingIdx) {
          const [removed] = routeStops.splice(currentMarkerIdx, 1);
          const newLastCyclingIdx = routeStops.findIndex(
            (s, ri) => ri > 0 && routeStops[ri - 1].delivery.transport_mode === "cycling" && !routeStops[ri - 1].delivery.is_cycling_marker && (routeStops[ri].delivery.transport_mode !== "cycling" || routeStops[ri].delivery.is_cycling_marker)
          );
          const insertAt = newLastCyclingIdx !== -1 ? newLastCyclingIdx : routeStops.length;
          routeStops.splice(insertAt, 0, removed);
          console.log(`[clientRouteEngine] ${source} \u2014 repositioned cycling END marker after cycling stops`);
        }
      }
    }
    console.log(`[clientRouteEngine] ${source} \u2014 cycling marker positional check complete (total routeStops=${routeStops.length})`);
  }
  _unitNumberMicroSort(routeStops, patientMap);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("routeOptimizationPhase", { detail: { phase: "polylines", source, driverId, deliveryDate } }));
  }
  let segmentPolylineByDeliveryId = /* @__PURE__ */ new Map();
  const deviationTransferChanges = /* @__PURE__ */ new Map();
  const _preOptOrderIds = activeRouteDeliveries.slice().sort((a, b) => (Number(a?.stop_order) || 99999) - (Number(b?.stop_order) || 99999)).map((d) => String(d.id));
  const _optimizedOrderIds = routeStops.map((s) => String(s.delivery?.id));
  const orderUnchangedForPolylines = !forceRegenerate && !preserveExistingOrder && !cyclingSegmentOnly && !drivingSegmentOnly && _preOptOrderIds.length === _optimizedOrderIds.length && _preOptOrderIds.every((id, index) => id === _optimizedOrderIds[index]);
  if (orderUnchangedForPolylines) {
    console.log(`[clientRouteEngine] ${source} \u2014 optimizer kept the existing stop order (${_optimizedOrderIds.length} stops) \u2014 requesting polyline skip`);
  }
  const activeRouteStops = routeStops.filter((s) => s.delivery.status !== "pending" || s.delivery.is_cycling_marker || cyclingSegmentOnly && String(s.delivery.transport_mode || "").toLowerCase() === "cycling");
  console.log(`[clientRouteEngine] ${source} \u2014 POLYLINE PHASE: routeStops=${routeStops.length}, activeRouteStops=${activeRouteStops.length} (pending excluded from polylines)`);
  if (activeRouteStops.length > 0) {
    const polylineOrigin = (() => {
      if (latestFinishedCoords) return { lat: latestFinishedCoords.lat, lon: latestFinishedCoords.lng };
      if (resolvedHomePosition) return { lat: resolvedHomePosition.lat, lon: resolvedHomePosition.lng };
      const firstActive = activeRouteStops[0];
      if (firstActive) return { lat: firstActive.lat, lon: firstActive.lng };
      return { lat: currentPosition.lat, lon: currentPosition.lng };
    })();
    const _polylineOriginSource = latestFinishedCoords ? "lastFinished" : resolvedHomePosition ? "home" : "firstActive";
    console.log(`[clientRouteEngine] ${source} \u2014 polylineOrigin=(${polylineOrigin.lat.toFixed(4)}, ${polylineOrigin.lon.toFixed(4)}) originSource=${_polylineOriginSource}`);
    try {
      {
        const validWaypoint = (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
        const inFlightStops = routeStops.filter((rs) => ["en_route", "in_transit"].includes(String(rs.delivery?.status || "")));
        const harvest = [];
        const holderStops = [];
        for (const rs of inFlightStops) {
          const pts = Array.isArray(rs.delivery?.deviation_waypoints) ? rs.delivery.deviation_waypoints.filter(validWaypoint) : [];
          if (pts.length > 0) holderStops.push({ rs, pts });
        }
        if (holderStops.length > 0) {
          const _routeInProgress = completedDeliveries.length > 0;
          const firstNonInterStore = inFlightStops.find((rs) => !isInterStoreDelivery(rs.delivery?.delivery_id)) || null;
          const newNextId = (explicitNextDelivery && !clearNextDeliveryLock ? explicitNextDelivery.id : null) || (clearNextDeliveryLock || !_routeInProgress ? firstNonInterStore?.delivery?.id || inFlightStops[0]?.delivery?.id || null : null);
          const keepers = newNextId ? holderStops.filter((h) => h.rs.delivery.id === newNextId) : holderStops;
          const movers = newNextId ? holderStops.filter((h) => h.rs.delivery.id !== newNextId) : [];
          if (movers.length > 0 && newNextId) {
            const movedPts = movers.flatMap((h) => h.pts).sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
            const newNextRs = inFlightStops.find((rs) => rs.delivery.id === newNextId);
            const newNextCoords = newNextRs ? { lat: newNextRs.lat, lng: newNextRs.lng } : null;
            const keptPts = newNextCoords ? movedPts.filter((pt) => {
              const dOrigin = haversineKm2(polylineOrigin.lat, polylineOrigin.lon, Number(pt.lat), Number(pt.lng));
              const dNext = haversineKm2(newNextCoords.lat, newNextCoords.lng, Number(pt.lat), Number(pt.lng));
              return dNext <= dOrigin;
            }) : [];
            const existingNextPts = keepers.flatMap((h) => h.pts).sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
            const merged = [...existingNextPts, ...keptPts].sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || ""))).slice(-3);
            for (const h of movers) {
              h.rs.delivery.deviation_waypoints = [];
              deviationTransferChanges.set(h.rs.delivery.id, []);
            }
            if (newNextRs) {
              newNextRs.delivery.deviation_waypoints = merged;
              deviationTransferChanges.set(newNextId, merged);
            }
            console.log(`[clientRouteEngine] ${source} \u2014 deviation waypoints transferred: ${movers.length} stop(s) emptied, ${keptPts.length}/${movedPts.length} point(s) moved onto new next stop (merged w/ ${existingNextPts.length} existing)`);
          }
        }
      }
    } catch (_devTransferErr) {
      console.warn("[clientRouteEngine] deviation waypoint transfer skipped (non-fatal):", _devTransferErr?.message || _devTransferErr);
    }
    const driverOnDuty = ["on_duty", "online"].includes(String(_driverAppUser?.driver_status || "").toLowerCase());
    const driverGpsCoords = _driverAppUser?.current_latitude != null && _driverAppUser?.current_longitude != null ? { lat: Number(_driverAppUser.current_latitude), lon: Number(_driverAppUser.current_longitude) } : null;
    const hasInFlightStop = activeRouteStops.some((s) => ["en_route", "in_transit"].includes(String(s.delivery?.status || "")));
    const routeIsToday2 = !isFutureRoute && !historicalRoute;
    const viaPointAfterOrigin = routeIsToday2 && driverOnDuty && hasInFlightStop && driverGpsCoords && Number.isFinite(driverGpsCoords.lat) && Number.isFinite(driverGpsCoords.lon) && !cyclingSegmentOnly && !drivingSegmentOnly && calculateCrowFliesDistance2(polylineOrigin.lat, polylineOrigin.lon, driverGpsCoords.lat, driverGpsCoords.lon) > 0.1 ? driverGpsCoords : null;
    console.log(`[clientRouteEngine] ${source} \u2014 live-GPS via point: ${viaPointAfterOrigin ? `(${viaPointAfterOrigin.lat.toFixed(4)}, ${viaPointAfterOrigin.lon.toFixed(4)})` : "off (gates: onDuty=" + driverOnDuty + ", inFlight=" + hasInFlightStop + ", gps=" + (driverGpsCoords ? "yes" : "no") + ")"}`);
    segmentPolylineByDeliveryId = await generateRoutePolylines({
      orderUnchanged: orderUnchangedForPolylines,
      forceRegenerate,
      stops: routeStops.map((s) => ({ delivery: s.delivery, lat: s.lat, lng: s.lng })),
      originPoint: polylineOrigin,
      cyclingSegmentOnly,
      hereApiKey,
      polylineProvider,
      polylineApiKey,
      driverId,
      userName: _driverUserName,
      source,
      fallbackTravelMode: effectiveTravelMode,
      directionsLegs,
      routeStops,
      viaPointAfterOrigin
    });
  }
  const _etaPreferLeg = orderUnchangedForPolylines;
  let _etaWinterPadFactor = null;
  if (_etaPreferLeg) {
    const _winter = await getWinterModeSettings().catch(() => null);
    if (_winter?.enabled && Number(_winter.eta_factor) > 0) _etaWinterPadFactor = _winter.eta_factor;
  }
  const stageEtaMap = /* @__PURE__ */ new Map();
  if (historicalRoute && routeStops.length > 0) {
    const firstStop = routeStops[0];
    let cumulativeTime = currentMinutes;
    const firstStopWindowStart = parseTimeToMinutes(firstStop.windowStart || firstStop.delivery.delivery_time_start || firstStop.delivery.time_window_start);
    if (Number.isFinite(firstStopWindowStart) && cumulativeTime < firstStopWindowStart) cumulativeTime = firstStopWindowStart;
    stageEtaMap.set(firstStop.delivery.id, formatMinutesToTime(cumulativeTime));
    cumulativeTime += firstStop.delivery.extra_time || (firstStop.isPickup ? 15 : 5);
    for (let i = 1; i < routeStops.length; i++) {
      const stop = routeStops[i];
      const seg = segmentPolylineByDeliveryId.get(stop.delivery.id) || null;
      const _prev = routeStops[i - 1];
      const _nearPrev = Number.isFinite(_prev?.lat) && Number.isFinite(stop?.lat) && calculateCrowFliesDistance2(_prev.lat, _prev.lng, stop.lat, stop.lng) < 0.05;
      cumulativeTime += getLegTravelMinutes({ stop, leg: directionsLegs[i], segmentPolyline: seg, nearPreviousStop: _nearPrev });
      const ws = parseTimeToMinutes(stop.windowStart || stop.delivery.delivery_time_start || stop.delivery.time_window_start);
      if (Number.isFinite(ws) && cumulativeTime < ws) cumulativeTime = ws;
      stageEtaMap.set(stop.delivery.id, formatMinutesToTime(cumulativeTime));
      cumulativeTime += dwellMinutesForStop({ extraTime: stop.delivery.extra_time, isPickup: stop.isPickup });
    }
  } else {
    let cumulativeTime = currentMinutes;
    if (isFutureRoute && routeStops.length > 0) {
      const firstStop = routeStops[0];
      const firstWindowStart = parseTimeToMinutes(firstStop.windowStart || firstStop.delivery.delivery_time_start);
      if (Number.isFinite(firstWindowStart)) cumulativeTime = firstWindowStart;
    }
    for (let i = 0; i < routeStops.length; i++) {
      const stop = routeStops[i];
      const seg = segmentPolylineByDeliveryId.get(stop.delivery.id) || null;
      const _legMode = String(stop.delivery?.transport_mode || effectiveTravelMode || "driving").toLowerCase();
      const _prev = i > 0 ? routeStops[i - 1] : null;
      const _nearPrev = _prev && Number.isFinite(_prev.lat) && Number.isFinite(stop.lat) && calculateCrowFliesDistance2(_prev.lat, _prev.lng, stop.lat, stop.lng) < 0.05;
      const travelMinutes = stop.delivery.is_cycling_marker && !seg ? 0 : getLegTravelMinutes({ stop, leg: directionsLegs[i], segmentPolyline: seg, preferLeg: _etaPreferLeg, winterPadFactor: _etaWinterPadFactor, legMode: _legMode, nearPreviousStop: _nearPrev });
      cumulativeTime += travelMinutes;
      const ws = parseTimeToMinutes(stop.windowStart || stop.delivery.delivery_time_start || stop.delivery.time_window_start);
      if (Number.isFinite(ws) && cumulativeTime < ws) cumulativeTime = ws;
      if (isFutureRoute && !routeOfficiallyStarted && stop.isPickup) {
        const pickupStart = parseTimeToMinutes(stop.delivery.delivery_time_start);
        if (Number.isFinite(pickupStart) && cumulativeTime < pickupStart) cumulativeTime = pickupStart;
      }
      stageEtaMap.set(stop.delivery.id, formatMinutesToTime(cumulativeTime));
      cumulativeTime += stop.delivery.extra_time || (stop.isPickup ? 15 : 5);
    }
  }
  const optimizedRouteStopsForResponse = routeStops.map((stop) => ({
    ...stop.delivery,
    delivery_time_eta: stageEtaMap.get(stop.delivery.id) || stop.delivery.delivery_time_eta
  }));
  let activeStops = routeStops.map((stop) => ({
    ...stop.delivery,
    delivery_time_eta: stageEtaMap.get(stop.delivery.id) || stop.delivery.delivery_time_eta
  }));
  activeStops = enforceIspBeforeIsd(activeStops, {
    deliveryIdOf: (st) => st.delivery_id,
    puidOf: (st) => st.puid,
    stopIdOf: (st) => st.stop_id
  });
  const maxCompletedOrder = completedDeliveries.reduce(
    (max, d) => Math.max(max, Number(d?.stop_order) || 0),
    0
  );
  const startOrder = startingStopOrder != null ? startingStopOrder : maxCompletedOrder;
  const originalActiveOrder = activeRouteDeliveries.slice().sort((a, b) => (Number(a?.stop_order) || 99999) - (Number(b?.stop_order) || 99999)).map((d) => String(d.id));
  const optimizedActiveOrder = activeStops.map((s) => String(s.id));
  const routeOrderChanged = preserveExistingOrder ? false : originalActiveOrder.length !== optimizedActiveOrder.length || originalActiveOrder.some((id, index) => id !== optimizedActiveOrder[index]);
  const routeInProgress = completedDeliveries.length > 0;
  const firstNonInterStoreActive = activeStops.find((s) => {
    const isISP_ISD = isInterStoreDelivery(s.delivery_id);
    return !isISP_ISD;
  }) || null;
  const nextStopId = (explicitNextDelivery && !clearNextDeliveryLock ? explicitNextDelivery.id : null) || (clearNextDeliveryLock ? firstNonInterStoreActive?.id || activeStops[0]?.id || null : !routeInProgress ? firstNonInterStoreActive?.id || activeStops[0]?.id || null : null);
  const finalizedById = new Map(activeStops.map((s) => [s.id, s]));
  const writeBatch = [];
  const resolvePendingStartTime = (stop) => {
    if (stop.status !== "pending") return void 0;
    if (!stop.patient_id) return stop.delivery_time_start || stop.delivery_time_eta;
    if (!stop.puid) return void 0;
    const pickup = activeStops.find((c) => !c.patient_id && c.stop_id === stop.puid) || allDeliveries.find((c) => !c.patient_id && c.stop_id === stop.puid);
    if (!pickup) return void 0;
    const pickupState = finalizedById.get(pickup.id) || pickup;
    let baseMinutes = parseTimeToMinutes(pickupState.delivery_time_eta);
    if (!Number.isFinite(baseMinutes)) baseMinutes = parseTimeToMinutes(pickupState.delivery_time_start);
    if (!Number.isFinite(baseMinutes)) return void 0;
    return formatMinutesToTime(baseMinutes + 5);
  };
  const sameCoordsAdjacentIds = /* @__PURE__ */ new Set();
  for (let i = 1; i < routeStops.length; i++) {
    const a = routeStops[i - 1], b = routeStops[i];
    if (a && b && Number.isFinite(a.lat) && Number.isFinite(b.lat) && calculateCrowFliesDistance2(a.lat, a.lng, b.lat, b.lng) < 0.05) {
      sameCoordsAdjacentIds.add(b.delivery.id);
    }
  }
  const computedStopOrders = activeStops.map((stop, i) => {
    if (preserveExistingOrder) return Number(stop.stop_order || 1);
    return startOrder + i + 1;
  });
  for (let i = 0; i < activeStops.length; i++) {
    const stop = activeStops[i];
    const newOrder = computedStopOrders[i];
    const pendingStartTime = resolvePendingStartTime(stop);
    const seg = segmentPolylineByDeliveryId.get(stop.id) || null;
    const existingMode = stop?.transport_mode ? String(stop.transport_mode).toLowerCase() : null;
    const rawTransportMode = existingMode && ["driving", "cycling", "pedestrian"].includes(existingMode) ? existingMode : String(effectiveTravelMode).toLowerCase();
    const safeTransportMode = ["driving", "cycling", "pedestrian"].includes(rawTransportMode) ? rawTransportMode : "driving";
    const isNextStop = stop.id === nextStopId;
    const logicalDurationMinutes = typeof seg?.estimatedDurationMinutes === "number" ? seg.estimatedDurationMinutes : null;
    const logicalDistanceKm = typeof seg?.estimatedDistanceKm === "number" ? seg.estimatedDistanceKm : null;
    const isPending = stop.status === "pending";
    const isInterStoreStop = isInterStoreDelivery(stop.delivery_id);
    const isPickupStop = !stop.patient_id && !stop.is_cycling_marker && !isInterStoreStop;
    const correctedStatus = isPickupStop && stop.status === "in_transit" ? "en_route" : void 0;
    const statusToWrite = correctedStatus || (stop.status === "in_transit" ? "in_transit" : void 0);
    const updateData = {
      stop_order: newOrder,
      delivery_time_eta: stop.delivery_time_eta,
      isNextDelivery: stop.id === nextStopId,
      ...stop.id !== nextStopId ? { isNextDelivery: false } : {},
      transport_mode: safeTransportMode,
      ...statusToWrite ? { status: statusToWrite } : {},
      travel_dist: isPending ? null : Number(directionsLegs[i]?.distance) ? Number((Number(directionsLegs[i].distance) / 1e3).toFixed(3)) : null,
      ...!isPending && logicalDurationMinutes != null ? { estimated_duration_minutes: logicalDurationMinutes } : {},
      ...!isPending && logicalDurationMinutes == null && sameCoordsAdjacentIds.has(stop.id) ? { estimated_duration_minutes: SAME_ADDRESS_TRAVEL_MINUTES, estimated_distance_km: 0 } : {},
      ...!isPending && logicalDistanceKm != null ? { estimated_distance_km: logicalDistanceKm } : {},
      // OWNER RULE (Oct 13 2026): stamp the stop_order this leg was generated
      // under, written atomically with encoded_polyline. The generator's skip
      // compares it against the record's CURRENT stop_order — if a manual
      // reorder (adjust panel) changed stop_order without regenerating legs,
      // the mismatch forces a full regeneration of ALL remaining stops.
      ...!isPending && seg?.encodedPolyline ? { encoded_polyline: seg.encodedPolyline, transport_mode: safeTransportMode, polyline_from_order: newOrder } : {},
      ...isPending ? { encoded_polyline: null, polyline_from_order: null, estimated_distance_km: null, estimated_duration_minutes: null } : {}
    };
    const _deviationWaypoints = deviationTransferChanges.get(stop.id);
    if (_deviationWaypoints) updateData.deviation_waypoints = _deviationWaypoints;
    if (pendingStartTime) {
      updateData.delivery_time_start = pendingStartTime;
      stop.delivery_time_start = pendingStartTime;
    }
    if (stop.patient_id && isPending) {
      const patient = patientMap.get(stop.patient_id);
      if (patient) {
        if (patient.time_window_start && !stop.delivery_time_start) {
          updateData.delivery_time_start = patient.time_window_start;
          stop.delivery_time_start = patient.time_window_start;
        }
        if (patient.time_window_end && !stop.delivery_time_end) {
          updateData.delivery_time_end = patient.time_window_end;
          stop.delivery_time_end = patient.time_window_end;
        }
      }
    }
    stop.stop_order = newOrder;
    stop.isNextDelivery = stop.id === nextStopId;
    writeBatch.push({ id: stop.id, data: updateData });
  }
  const _polylineWriteCount = writeBatch.filter((w) => w.data?.encoded_polyline != null).length;
  const _pendingClearCount = writeBatch.filter((w) => w.data?.encoded_polyline === null).length;
  console.log(`[clientRouteEngine] ${source} \u2014 WRITE BATCH: ${writeBatch.length} updates, ${_polylineWriteCount} with polylines, ${_pendingClearCount} pending-cleared`);
  const orderedDeliveryIds = optimizedRouteStopsForResponse.map((s) => s.id);
  const optimizedRoute = optimizedRouteStopsForResponse.map((stop, index) => {
    const writeEntry = writeBatch.find((b) => b.id === stop.id);
    const legIndex = routeStops.findIndex((s) => s.delivery.id === stop.id);
    return {
      deliveryId: stop.id,
      newETA: stop.delivery_time_eta,
      stop_order: writeEntry?.data?.stop_order ?? startOrder + index + 1,
      isNextDelivery: stop.id === nextStopId,
      transport_mode: stop.transport_mode || "driving",
      encoded_polyline: segmentPolylineByDeliveryId.get(stop.id)?.encodedPolyline || null,
      estimated_distance_km: writeEntry?.data?.estimated_distance_km ?? null,
      estimated_duration_minutes: writeEntry?.data?.estimated_duration_minutes ?? null,
      travel_dist: legIndex >= 0 && Number(directionsLegs[legIndex]?.distance) ? Number((Number(directionsLegs[legIndex].distance) / 1e3).toFixed(3)) : null
    };
  });
  return {
    success: true,
    driverId,
    deliveryDate,
    routeChanged: routeOrderChanged,
    optimizedCount: routeStops.length,
    locationSource,
    usedTimeWindows,
    usedFallbackOrdering,
    preserveExistingOrder,
    nextDeliveryId: nextStopId,
    shouldRefreshPolylines: activeStops.length > 0,
    orderedDeliveryIds,
    optimizedRoute,
    writeBatch
  };
}
async function _handleFutureRoute({ optimizableDeliveries, storeMap, patientMap, deliveryDate, startingStopOrder, completedDeliveries, currentMinutes, source, hereApiKey, polylineProvider = "here", polylineApiKey = null, driverHomeLocation = null, driverId = null, userName = null, effectiveTravelMode = "driving" }) {
  const startOrder = startingStopOrder != null ? startingStopOrder : completedDeliveries.length;
  const weekdayCode = getWeekdayCode(deliveryDate);
  const isWeekend = weekdayCode === "sa" || weekdayCode === "su";
  const isSaturday = weekdayCode === "sa";
  const getStoreDefaultWindow = (storeId, ampm) => {
    const sw = storeMap.get(storeId);
    if (!sw) return { start: null, end: null };
    const prefix = isSaturday ? "saturday" : isWeekend ? "sunday" : "weekday";
    const slot = (ampm || "AM").toUpperCase() === "PM" ? "pm" : "am";
    return { start: sw[`${prefix}_${slot}_start`] || null, end: sw[`${prefix}_${slot}_end`] || null };
  };
  const pickups = optimizableDeliveries.filter((d) => !d.patient_id);
  const normalizedPickups = pickups.map((p) => {
    const dw = getStoreDefaultWindow(p.store_id, p.ampm_deliveries);
    return {
      ...p,
      delivery_time_start: p.delivery_time_start || dw.start || p.delivery_time_start,
      delivery_time_end: p.delivery_time_end || dw.end || p.delivery_time_end
    };
  }).sort(
    (a, b) => parseTimeToMinutes(a.delivery_time_start || "00:00") - parseTimeToMinutes(b.delivery_time_start || "00:00")
  );
  const pickupByPuid = new Map(normalizedPickups.map((p) => [p.stop_id, p]));
  const normalizedDeliveries = optimizableDeliveries.filter((d) => d.patient_id).map((d) => {
    const patient = patientMap.get(d.patient_id);
    const pickup = d.puid ? pickupByPuid.get(d.puid) : null;
    const pickupStartMin = pickup?.delivery_time_start ? parseTimeToMinutes(pickup.delivery_time_start) : Infinity;
    let newStart = d.delivery_time_start;
    let newEnd = d.delivery_time_end;
    if (!d.delivery_time_start && patient?.time_window_start) {
      newStart = patient.time_window_start;
      if (!d.delivery_time_end && patient.time_window_end) newEnd = patient.time_window_end;
    } else if (!d.delivery_time_start && Number.isFinite(pickupStartMin)) {
      newStart = formatMinutesToTime(pickupStartMin + 5);
    }
    return {
      ...d,
      delivery_time_start: newStart || d.delivery_time_start,
      delivery_time_end: newEnd || d.delivery_time_end,
      time_window_start: patient?.time_window_start || d.time_window_start || null,
      time_window_end: patient?.time_window_end || d.time_window_end || null
    };
  });
  const sortedDeliveries = normalizedDeliveries.slice().sort(
    (a, b) => parseTimeToMinutes(a.delivery_time_start || "99:99") - parseTimeToMinutes(b.delivery_time_start || "99:99")
  );
  const _IN_HAND_STATUSES = ["en_route", "in_transit"];
  const addedDeliveryIds = /* @__PURE__ */ new Set();
  const blocks = [];
  for (const pickup of normalizedPickups) {
    const items = [{ delivery: pickup, isPickup: true }];
    for (const del of sortedDeliveries.filter(
      (d) => d.puid === pickup.stop_id && !_IN_HAND_STATUSES.includes(String(d.status || "").toLowerCase())
    )) {
      items.push({ delivery: del, isPickup: false });
      addedDeliveryIds.add(del.id);
    }
    blocks.push({ startMin: parseTimeToMinutes(pickup.delivery_time_start || "99:99"), items });
  }
  for (const del of sortedDeliveries) {
    if (addedDeliveryIds.has(del.id)) continue;
    blocks.push({ startMin: parseTimeToMinutes(del.delivery_time_start || "99:99"), items: [{ delivery: del, isPickup: false }] });
  }
  const _BLANK_ANCHOR = parseTimeToMinutes("99:99");
  const routeIsTodayPreStart = deliveryDate === getEdmontonTodayDateString();
  if (routeIsTodayPreStart) {
    for (const b of blocks) {
      if (Number.isFinite(b.startMin) && b.startMin < currentMinutes) b.startMin = currentMinutes;
    }
  }
  const windowedBlocks = blocks.filter((b) => Number.isFinite(b.startMin) && b.startMin < _BLANK_ANCHOR);
  windowedBlocks.sort((a, b) => a.startMin - b.startMin);
  const blankBlocks = blocks.filter((b) => !windowedBlocks.includes(b));
  let orderedStops;
  if (blankBlocks.length === 0) {
    orderedStops = windowedBlocks.flatMap((b) => b.items);
  } else {
    const _unitCoords = (b) => {
      const first = b.items[0]?.delivery || null;
      const c = first ? getDeliveryCoords(first, patientMap, storeMap) : null;
      return c && Number.isFinite(c.lat) && Number.isFinite(c.lng) ? c : null;
    };
    const firstWindowedCoords = windowedBlocks.length ? _unitCoords(windowedBlocks[0]) : null;
    let cursor = driverHomeLocation || firstWindowedCoords || _unitCoords(blankBlocks[0]);
    const remainingBlank = blankBlocks.slice();
    const blankSeq = [];
    while (remainingBlank.length) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < remainingBlank.length; i++) {
        const c = _unitCoords(remainingBlank[i]);
        if (!c || !cursor) {
          bestIdx = i;
          break;
        }
        const d = calculateCrowFliesDistance2(cursor.lat, cursor.lng, c.lat, c.lng);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      blankSeq.push(remainingBlank.splice(bestIdx, 1)[0]);
      cursor = _unitCoords(blankSeq[blankSeq.length - 1]) || cursor;
    }
    console.log(`[clientRouteEngine] ${source} \u2014 FUTURE/pre-start route: ${blankBlocks.length} blank-start block(s) sequenced by DISTANCE from origin (${driverHomeLocation ? "driver_home" : firstWindowedCoords ? "first_windowed_stop" : "first_blank_unit"}), leading the route; ${windowedBlocks.length} windowed block(s) follow chronologically${routeIsTodayPreStart ? " (past windows clamped to now)" : ""}`);
    orderedStops = [...blankSeq.flatMap((b) => b.items), ...windowedBlocks.flatMap((b) => b.items)];
  }
  const firstStop = orderedStops[0];
  let _etaBase = firstStop ? parseTimeToMinutes(firstStop.delivery.delivery_time_start || "") : NaN;
  if (!Number.isFinite(_etaBase) || _etaBase >= _BLANK_ANCHOR) {
    const _firstWindowedAnchor = windowedBlocks.find((b) => Number.isFinite(b.startMin) && b.startMin < _BLANK_ANCHOR)?.startMin;
    _etaBase = Number.isFinite(_firstWindowedAnchor) ? _firstWindowedAnchor : Math.max(currentMinutes, 9 * 60);
  }
  let cumulativeTime = Number.isFinite(_etaBase) ? _etaBase : currentMinutes;
  const etaMap = /* @__PURE__ */ new Map();
  for (let i = 0; i < orderedStops.length; i++) {
    const { delivery, isPickup } = orderedStops[i];
    if (isPickup) {
      const ps = parseTimeToMinutes(delivery.delivery_time_start || "00:00");
      if (Number.isFinite(ps) && cumulativeTime < ps) cumulativeTime = ps;
    }
    const ws = parseTimeToMinutes(delivery.delivery_time_start || delivery.time_window_start || "");
    if (Number.isFinite(ws) && cumulativeTime < ws) cumulativeTime = ws;
    etaMap.set(delivery.id, formatMinutesToTime(cumulativeTime));
    cumulativeTime += delivery.extra_time || (isPickup ? 15 : 5);
  }
  const _futureFirstNonISPId = orderedStops.find(({ delivery: d }) => !isInterStoreDelivery(d.delivery_id))?.delivery.id || orderedStops[0]?.delivery.id || null;
  const writeBatch = orderedStops.map(({ delivery, isPickup }, i) => {
    const newEta = etaMap.get(delivery.id);
    const updateData = { stop_order: startOrder + i + 1, delivery_time_eta: newEta, isNextDelivery: delivery.id === _futureFirstNonISPId };
    const np = isPickup ? normalizedPickups.find((p) => p.id === delivery.id) : null;
    if (np) {
      if (np.delivery_time_start !== delivery.delivery_time_start) updateData.delivery_time_start = np.delivery_time_start;
      if (np.delivery_time_end !== delivery.delivery_time_end) updateData.delivery_time_end = np.delivery_time_end;
    }
    if (!isPickup) {
      const nd = normalizedDeliveries.find((d) => d.id === delivery.id);
      if (nd) {
        if (nd.delivery_time_start && nd.delivery_time_start !== delivery.delivery_time_start) updateData.delivery_time_start = nd.delivery_time_start;
        if (nd.delivery_time_end && nd.delivery_time_end !== delivery.delivery_time_end) updateData.delivery_time_end = nd.delivery_time_end;
      }
    }
    return { id: delivery.id, data: updateData };
  });
  const futurePolylineByDeliveryId = await generateRoutePolylines({
    stops: orderedStops.map(({ delivery }) => {
      const c = getDeliveryCoords(delivery, patientMap, storeMap);
      return { delivery, lat: c?.lat, lng: c?.lng };
    }).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)),
    originPoint: driverHomeLocation,
    cyclingSegmentOnly: false,
    hereApiKey,
    polylineProvider,
    polylineApiKey,
    driverId,
    userName,
    source,
    fallbackTravelMode: effectiveTravelMode
  });
  for (const w of writeBatch) {
    const seg = futurePolylineByDeliveryId.get(w.id);
    if (!seg) continue;
    if (seg.encodedPolyline != null) {
      w.data.encoded_polyline = seg.encodedPolyline;
      w.data.polyline_from_order = w.data.stop_order ?? null;
    }
    if (seg.transportMode) w.data.transport_mode = seg.transportMode;
    if (seg.estimatedDistanceKm != null) w.data.estimated_distance_km = seg.estimatedDistanceKm;
    if (seg.estimatedDurationMinutes != null) w.data.estimated_duration_minutes = seg.estimatedDurationMinutes;
  }
  return {
    success: true,
    driverId: null,
    deliveryDate,
    routeChanged: true,
    optimizedCount: writeBatch.length,
    locationSource: "future_schedule",
    usedTimeWindows: true,
    usedFallbackOrdering: false,
    preserveExistingOrder: false,
    shouldRefreshPolylines: true,
    orderedDeliveryIds: writeBatch.map((w) => w.id),
    optimizedRoute: writeBatch.map((w, i) => ({ deliveryId: w.id, newETA: w.data.delivery_time_eta, stop_order: startOrder + i + 1, isNextDelivery: w.data.isNextDelivery === true, encoded_polyline: w.data.encoded_polyline || null, transport_mode: w.data.transport_mode || null })),
    writeBatch
  };
}
function _unitNumberMicroSort(routeStops, patientMap) {
  const GPS_PRECISION = 4;
  const roundGps = (v) => Number(Number(v).toFixed(GPS_PRECISION));
  const processed = /* @__PURE__ */ new Set();
  for (let i = 0; i < routeStops.length; i++) {
    if (processed.has(i)) continue;
    const stop = routeStops[i];
    const d = stop.delivery;
    if (d.status !== "in_transit" || !d.patient_id || !String(d.delivery_id || "").toUpperCase().startsWith("DID")) continue;
    const lat = roundGps(stop.lat);
    const lng = roundGps(stop.lng);
    const groupIndices = [i];
    for (let j = i + 1; j < routeStops.length; j++) {
      const s = routeStops[j];
      if (s.delivery.status !== "in_transit" || !s.delivery.patient_id || !String(s.delivery.delivery_id || "").toUpperCase().startsWith("DID")) continue;
      if (roundGps(s.lat) === lat && roundGps(s.lng) === lng) groupIndices.push(j);
    }
    if (groupIndices.length < 2) {
      processed.add(i);
      continue;
    }
    const group = groupIndices.map((idx) => routeStops[idx]);
    group.sort((a, b) => {
      const ua = String(a.delivery.unit_number || patientMap.get(a.delivery.patient_id)?.unit_number || "").trim();
      const ub = String(b.delivery.unit_number || patientMap.get(b.delivery.patient_id)?.unit_number || "").trim();
      const na = parseInt(ua, 10);
      const nb = parseInt(ub, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return ua.localeCompare(ub);
    });
    groupIndices.forEach((idx, pos) => {
      routeStops[idx] = group[pos];
      processed.add(idx);
    });
  }
}
export {
  getDeliveryCoords,
  getLatestFinishedDelivery,
  optimizeRouteClientSide
};
