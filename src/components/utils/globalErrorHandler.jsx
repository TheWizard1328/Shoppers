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

// Patch: After assign-all / accept-all functions complete, refresh deliveries on this device immediately
(function patchFunctionsInvokeForBulkOps() {
  try {
    if (typeof window === 'undefined') return;
    if (window.__rx_functions_invoke_patched__) return;
    if (!base44?.functions?.invoke) return;

    window.__rx_functions_invoke_patched__ = true;
    const originalInvoke = base44.functions.invoke.bind(base44.functions);

    base44.functions.invoke = async (functionName, payload = {}) => {
      const result = await originalInvoke(functionName, payload);

      // Heuristic: detect bulk ops like "assign all" or "accept all"
      try {
        const name = String(functionName || '').toLowerCase();
        const isBulkAssignOrAccept = /(assign.?all|accept.?all)/i.test(name);

        if (isBulkAssignOrAccept) {
          // Determine selected date from global filters if available
          let selectedDateStr = null;
          try {
            const gfMod = await import('./globalFilters');
            const { globalFilters } = gfMod;
            const sel = globalFilters?.getSelectedDate?.();
            if (sel instanceof Date) {
              selectedDateStr = sel.toISOString().slice(0, 10);
            } else if (typeof sel === 'string' && sel) {
              selectedDateStr = sel;
            }
          } catch {}

          if (!selectedDateStr) {
            const now = new Date();
            selectedDateStr = now.toISOString().slice(0, 10);
          }

          // Fetch fresh deliveries for the date and broadcast an IMMEDIATE UI update
          let freshDeliveries = [];
          try {
            freshDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
          } catch {}

          try {
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
              detail: { immediate: true, freshDeliveries, deliveryDate: selectedDateStr }
            }));
          } catch {}
        }
      } catch {}

      return result;
    };
  } catch (e) {
    // Silent failure: do not break app if patching fails
  }
})();