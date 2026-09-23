const MAX_SAMPLES = 10;
const DEGRADED_HOLD_MS = 30000;

const getNavigatorOnline = () =>
  typeof navigator === 'undefined' ? true : navigator.onLine !== false;

const getNetworkInformation = () => {
  if (typeof navigator === 'undefined') return null;
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
};

const classifyNetworkInformation = (connection) => {
  if (!connection) return 'good';
  const effectiveType = String(connection.effectiveType || '').toLowerCase();
  const rtt = Number(connection.rtt);
  const downlink = Number(connection.downlink);

  if (effectiveType === 'slow-2g' || effectiveType === '2g') return 'poor';
  if (effectiveType === '3g') return 'fair';
  if (Number.isFinite(rtt) && rtt >= 1200) return 'poor';
  if (Number.isFinite(rtt) && rtt >= 650) return 'fair';
  if (Number.isFinite(downlink) && downlink > 0 && downlink <= 0.5) return 'poor';
  if (Number.isFinite(downlink) && downlink > 0 && downlink <= 1.5) return 'fair';
  return 'good';
};

/**
 * Shared connection-health state.
 *
 * navigator.onLine only reports whether the device has a network interface. A
 * phone can still be black-holed, connected to weak cellular, or stuck during a
 * handoff. This monitor combines browser online/offline events, the Network
 * Information API when available, API latency samples, and real request errors.
 */
class ConnectionMonitor {
  constructor() {
    this.isOnline = getNavigatorOnline();
    this.connection = getNetworkInformation();
    this.responseTimeSamples = [];
    this.listeners = new Set();
    this.degradedUntil = 0;
    this.rateLimitedUntil = 0;
    this.lastErrorType = null;
    this._degradeTimer = null;
    this.quality = this.isOnline ? classifyNetworkInformation(this.connection) : 'offline';

    if (typeof window !== 'undefined') {
      this._handleOnline = () => this.handleOnline();
      this._handleOffline = () => this.handleOffline();
      this._handleConnectionChange = () => this.recalculate();
      window.addEventListener('online', this._handleOnline);
      window.addEventListener('offline', this._handleOffline);
      this.connection?.addEventListener?.('change', this._handleConnectionChange);
    }
  }

  handleOnline() {
    this.isOnline = true;
    // Do not immediately claim the connection is healthy. Keep it fair until a
    // request succeeds or browser network information proves it is good.
    this.quality = classifyNetworkInformation(this.connection) === 'good' ? 'fair' : classifyNetworkInformation(this.connection);
    this.notifyListeners();
    clearTimeout(this._degradeTimer);
    this._degradeTimer = setTimeout(() => this.recalculate(), 10000);
  }

  handleOffline() {
    this.isOnline = false;
    this.quality = 'offline';
    this.lastErrorType = 'offline';
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

  recordError(errorType = 'network') {
    this.isOnline = getNavigatorOnline();
    this.lastErrorType = errorType;
    if (errorType === 'rate_limit') {
      // HTTP 429 means the SERVER is refusing more requests, not that this
      // device's Wi-Fi/Ethernet/cellular link is weak. Retain the existing
      // 30-second canAttemptNetwork backoff without fabricating a signal loss.
      this.rateLimitedUntil = Date.now() + DEGRADED_HOLD_MS;
      this.recalculate();
      return;
    }
    this.degradedUntil = Date.now() + DEGRADED_HOLD_MS;
    this.quality = this.isOnline ? 'poor' : 'offline';
    this.notifyListeners();
    clearTimeout(this._degradeTimer);
    this._degradeTimer = setTimeout(() => this.recalculate(), DEGRADED_HOLD_MS + 100);
  }

  recalculate() {
    this.isOnline = getNavigatorOnline();
    if (!this.isOnline) {
      this.quality = 'offline';
      this.notifyListeners();
      return;
    }

    const browserQuality = classifyNetworkInformation(this.connection);
    if (Date.now() < this.degradedUntil) {
      this.quality = 'poor';
    } else {
      const recent = this.responseTimeSamples.filter((sample) => Date.now() - sample.timestamp <= 120000);
      const average = recent.length
        ? recent.reduce((sum, sample) => sum + sample.time, 0) / recent.length
        : null;
      const measuredQuality = average == null ? 'good' : average >= 5000 ? 'poor' : average >= 2000 ? 'fair' : 'good';
      this.quality = browserQuality === 'poor' || measuredQuality === 'poor'
        ? 'poor'
        : browserQuality === 'fair' || measuredQuality === 'fair'
          ? 'fair'
          : 'good';
    }
    this.notifyListeners();
  }

  canAttemptNetwork() {
    return this.isOnline && this.quality !== 'poor' && Date.now() >= this.rateLimitedUntil;
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
      lastErrorType: this.lastErrorType,
    };
  }

  subscribe(callback) {
    this.listeners.add(callback);
    try { callback(this.getQuality()); } catch {}
    return () => this.listeners.delete(callback);
  }

  notifyListeners() {
    const status = this.getQuality();
    this.listeners.forEach((callback) => {
      try { callback(status); } catch {}
    });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('connectionHealthChanged', { detail: status }));
    }
  }
}

export const connectionMonitor = new ConnectionMonitor();
