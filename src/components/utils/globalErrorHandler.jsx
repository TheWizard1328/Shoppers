// Global utility bootstrap (kept lightweight) + optimistic local patches
import { base44 } from '@/api/base44Client';
import { realtimeSync } from './realtimeSync';

// Create a safe wrapper for any potentially problematic code (kept for compatibility)
export const safeExecute = (fn, fallback = null) => {
  try { return fn(); } catch (error) { throw error; }
};

// Patch: Optimistic Patient GPS update so the local device UI updates instantly
(function applyPatientOptimisticPatch() {
  try {
    if (typeof window === 'undefined') return;
    if (window.__rx_patient_update_optimistic_patched__) return;
    if (!base44?.entities?.Patient?.update) return;

    window.__rx_patient_update_optimistic_patched__ = true;
    const originalUpdate = base44.entities.Patient.update;

    base44.entities.Patient.update = async (id, data) => {
      // Optimistically broadcast and persist minimal changes BEFORE network returns
      try {
        const optimisticRecord = { id, ...data };
        // 1) Broadcast as if it came from realtime so Layout updates state immediately
        try { realtimeSync.broadcast('Patient', 'update', id, optimisticRecord); } catch {}
        // 2) Save to offline DB right away (best-effort)
        try {
          const mod = await import('./offlineDatabase');
          const { offlineDB } = mod;
          await offlineDB.save(offlineDB.STORES.PATIENTS, optimisticRecord);
        } catch {}
        // 3) Fire a lightweight event that map layers can listen to (if any)
        try { window.dispatchEvent(new CustomEvent('patientLocationUpdated', { detail: { id, data, source: 'optimistic' } })); } catch {}
      } catch {}

      // Proceed with the real API call
      const res = await originalUpdate(id, data);

      // After success, broadcast again with server-normalized data (ensures consistency)
      try {
        const serverRecord = (res && typeof res === 'object' && res.id) ? res : { id, ...data };
        realtimeSync.broadcast('Patient', 'update', id, serverRecord);
        // Persist normalized record
        const mod = await import('./offlineDatabase');
        const { offlineDB } = mod;
        await offlineDB.save(offlineDB.STORES.PATIENTS, serverRecord);
      } catch {}

      return res;
    };
  } catch (e) {
    // Silent fail: do not disrupt app init if patching fails
  }
})();

console.log('Bootstrap loaded: optimistic Patient GPS updates enabled on this device');