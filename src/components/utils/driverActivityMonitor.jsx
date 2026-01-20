/**
 * Driver Activity Monitor
 * DISABLED: Auto-break feature removed - drivers manually control their status
 * Only auto back-on-duty from break when completing next stop
 */

import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

class DriverActivityMonitor {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
  }

  start(currentUser) {
    // DISABLED: Auto-brake feature removed
    console.log('⏸️ [Activity Monitor] Auto-brake disabled - drivers control status manually');
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
  }

  async checkDriverActivity(currentUser) {
    // DISABLED: Auto-brake feature removed
    return;
  }
}

export const driverActivityMonitor = new DriverActivityMonitor();