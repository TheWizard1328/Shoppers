import { useEffect } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * useSidebarEntitySubscriptions
 *
 * Subscribes the sidebar to real-time WebSocket push events for all key entities.
 * On any change, dispatches the same custom events that useLayoutEventHandlers already
 * consumes — so no new state management is needed.
 */
export function useSidebarEntitySubscriptions(currentUser) {
  useEffect(() => {
    if (!currentUser) return;

    const unsubs = [];

    // ── AppUser ──────────────────────────────────────────────────────────────
    // CRITICAL: Do NOT dispatch driverLocationsUpdated from this sidebar subscription.
    // realtimeSync.subscribeToEntity('AppUser') already handles the authoritative WS path for
    // shared location markers — it dispatches driverLocationsUpdated with the full record and
    // writes to the offline DB atomically. A second subscription here firing simultaneously
    // causes two driverLocationsUpdated events per GPS write on secondary devices. The second
    // event arrives with appUsers:null / singleUpdate (which DriverLocationMarkers ignores due
    // to the null-check guard), but it also triggers pullToSyncDataReady → setAppUsers state
    // update → prop re-render → a third mergeVisibleDriversByFreshness pass with potentially
    // stale coords, causing the marker to bounce back to an old position.
    //
    // This subscription is kept ONLY for sidebar badge counts (onlineCounts etc.) via
    // pullToSyncDataReady — location marker updates are exclusively owned by realtimeSync.
    unsubs.push(base44.entities.AppUser.subscribe((event) => {
      if (!event?.data && event?.type !== 'delete') return;
      if (event.type === 'delete') {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { preserveLocalState: true, deletedIds: [event.id] }
        }));
      } else {
        // Update appUsers state in Layout (drives sidebar badge counts like onlineCounts).
        // Do NOT dispatch driverLocationsUpdated here — realtimeSync owns that path.
        window.dispatchEvent(new CustomEvent('pullToSyncDataReady', {
          detail: { appUsers: [event.data] }
        }));
      }
    }));

    // ── Delivery ─────────────────────────────────────────────────────────────
    unsubs.push(base44.entities.Delivery.subscribe((event) => {
      if (!event?.data && event?.type !== 'delete') return;
      if (event.type === 'delete') {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { preserveLocalState: true, deletedIds: [event.id] }
        }));
      } else {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { preserveLocalState: true, freshDeliveries: [event.data] }
        }));
      }
    }));

    // ── Patient ──────────────────────────────────────────────────────────────
    unsubs.push(base44.entities.Patient.subscribe((event) => {
      if (!event?.data && event?.type !== 'delete') return;
      if (event.type === 'delete') {
        window.dispatchEvent(new CustomEvent('patientsUpdated', {
          detail: { deletedId: event.id }
        }));
      } else {
        window.dispatchEvent(new CustomEvent('patientsUpdated', {
          detail: { patients: [event.data] }
        }));
      }
    }));

    // ── Payroll ──────────────────────────────────────────────────────────────
    // Payroll changes trigger a navigation badge refresh
    unsubs.push(base44.entities.Payroll.subscribe(() => {
      window.dispatchEvent(new CustomEvent('payrollUpdated'));
    }));

    // ── Company ──────────────────────────────────────────────────────────────
    unsubs.push(base44.entities.Company.subscribe(() => {
      window.dispatchEvent(new CustomEvent('forceDataRefresh'));
    }));

    // ── City ─────────────────────────────────────────────────────────────────
    unsubs.push(base44.entities.City.subscribe((event) => {
      if (!event?.data && event?.type !== 'delete') return;
      window.dispatchEvent(new CustomEvent('forceDataRefresh'));
    }));

    // ── Store ─────────────────────────────────────────────────────────────────
    unsubs.push(base44.entities.Store.subscribe((event) => {
      if (!event?.data && event?.type !== 'delete') return;
      window.dispatchEvent(new CustomEvent('pullToSyncDataReady', {
        detail: event.type === 'delete'
          ? {}
          : { stores: [event.data] }
      }));
    }));

    // ── AdminMetricsSummary ──────────────────────────────────────────────────
    unsubs.push(base44.entities.AdminMetricsSummary.subscribe(() => {
      window.dispatchEvent(new CustomEvent('adminMetricsUpdated'));
    }));

    // ── DriverScheduleOverride ───────────────────────────────────────────────
    // Already subscribed inside AppSidebar for the bookedOffCount badge.
    // No additional subscription needed here to avoid double-handling.

    return () => unsubs.forEach((fn) => fn && fn());
  }, [currentUser?.id]);
}