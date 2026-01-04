/**
 * Connection Quality Monitor
 * Tracks API response times and connection health
 */

class ConnectionMonitor {
  constructor() {
    this.quality = 'good'; // good | fair | poor
    this.lastCheckTime = Date.now();
    this.responseTimeSamples = [];
    this.maxSamples = 10;
    this.listeners = [];
    this.isOnline = navigator.onLine;
    
    // Listen for online/offline events
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
  }
  
  handleOnline() {
    this.isOnline = true;
    this.quality = 'good';
    this.notifyListeners();
  }
  
  handleOffline() {
    this.isOnline = false;
    this.quality = 'poor';
    this.notifyListeners();
  }
  
  /**
   * Record an API call response time
   */
  recordResponseTime(timeMs) {
    this.responseTimeSamples.push({
      time: timeMs,
      timestamp: Date.now()
    });
    
    // Keep only last N samples
    if (this.responseTimeSamples.length > this.maxSamples) {
      this.responseTimeSamples.shift();
    }
    
    this.updateQuality();
  }
  
  /**
   * Record an API error (rate limit, timeout, etc.)
   */
  recordError(errorType) {
    if (errorType === 'rate_limit' || errorType === '429') {
      this.quality = 'poor';
    } else if (errorType === 'timeout' || errorType === 'network') {
      this.quality = 'poor';
    }
    
    this.notifyListeners();
  }
  
  /**
   * Update quality based on response times
   */
  updateQuality() {
    if (!this.isOnline) {
      this.quality = 'poor';
      this.notifyListeners();
      return;
    }
    
    if (this.responseTimeSamples.length === 0) {
      this.quality = 'good';
      this.notifyListeners();
      return;
    }
    
    // Calculate average response time
    const avg = this.responseTimeSamples.reduce((sum, s) => sum + s.time, 0) / this.responseTimeSamples.length;
    
    // Quality thresholds
    if (avg < 1000) {
      this.quality = 'good'; // < 1 second
    } else if (avg < 3000) {
      this.quality = 'fair'; // 1-3 seconds
    } else {
      this.quality = 'poor'; // > 3 seconds
    }
    
    this.notifyListeners();
  }
  
  /**
   * Get current quality
   */
  getQuality() {
    return {
      quality: this.quality,
      isOnline: this.isOnline,
      avgResponseTime: this.getAverageResponseTime()
    };
  }
  
  getAverageResponseTime() {
    if (this.responseTimeSamples.length === 0) return null;
    return Math.round(
      this.responseTimeSamples.reduce((sum, s) => sum + s.time, 0) / this.responseTimeSamples.length
    );
  }
  
  /**
   * Subscribe to quality changes
   */
  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  }
  
  notifyListeners() {
    const status = this.getQuality();
    this.listeners.forEach(cb => {
      try { cb(status); } catch (e) {}
    });
  }
}

export const connectionMonitor = new ConnectionMonitor();