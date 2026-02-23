/**
 * Manages continuous map updates for Phase 2 and Phase 3
 * Listens to driver location changes and re-triggers map bounds
 */
export class MapPhaseLocationSync {
  constructor() {
    this.listeners = [];
    this.isActive = false;
    this.currentPhase = 1;
  }

  /**
   * Subscribe to location updates - notifies when map should update
   */
  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  /**
   * Notify all listeners that location has updated
   */
  notifyUpdate() {
    if (!this.isActive || (this.currentPhase !== 2 && this.currentPhase !== 3)) {
      return;
    }
    
    console.log(`🗺️ [MapPhaseSync] Location updated - notifying ${this.listeners.length} listeners for Phase ${this.currentPhase}`);
    this.listeners.forEach(callback => callback());
  }

  /**
   * Set current phase and activation state
   */
  setPhase(phase, isLocked) {
    this.currentPhase = phase;
    this.isActive = isLocked && (phase === 2 || phase === 3);
    console.log(`🗺️ [MapPhaseSync] Phase ${phase}, locked: ${isLocked}, active: ${this.isActive}`);
  }
}

// Global singleton instance
export const mapPhaseLocationSync = new MapPhaseLocationSync();