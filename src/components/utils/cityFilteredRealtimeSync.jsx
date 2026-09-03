// cityFilteredRealtimeSync.js - Real-time subscriptions filtered by city and date

import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { applyTerminalStatusGuard } from './completionLockout';
import { isDeleted, isDeletedByContent, filterDeleted } from "./deletedDeliveryRegistry";

class CityFilteredRealtimeSync {
  constructor() {
    this.deliveryUnsubscribe = null;
    this.appUserUnsubscribe = null;
    this.patientUnsubscribe = null;
    this.isActive = false;
    this.currentCityId = null;
    this.currentDate = null;
    this.updateCallbacks = new Set();
    this.lastDeliveryUpdate = null;
    this.lastAppUserUpdate = null;
    this.lastPatientUpdate = null;
    
    // Batch event tracking for diagnostics
    this.batchDeliveryEvents = [];
    this.batchTimeout = null;
  }

  /**
   * Subscribe to callbacks when real-time updates arrive
   */
  subscribe(callback) {
    this.updateCallbacks.add(callback);
    return () => this.updateCallbacks.delete(callback);
  }

  /**
   * Notify all subscribers of updates
   */
  notifySubscribers(entityType, eventType, data) {
    this.updateCallbacks.forEach(callback => {
      callback({ entityType, eventType, data });
    });
  }

  /**
   * Start real-time subscriptions for deliveries and AppUsers
   * Filtered by city only (NOT by date to catch all delivery updates)
   */
  start(cityId, selectedDate) {
    if (this.isActive) {
      this.stop();
    }

    this.currentCityId = cityId;
    this.currentDate = selectedDate;
    this.isActive = true;

    // Lazy load reconciler to avoid circular dependencies
    const getReconciler = async () => {
      try {
        const { deliveryWebSocketReconciler } = await import('./deliveryWebSocketReconciler');
        return deliveryWebSocketReconciler;
      } catch (e) {
        console.warn('⚠️ [cityFilteredRealtimeSync] Failed to load reconciler:', e.message);
        return null;
      }
    };

    this.deliveryUnsubscribe = base44.entities.Delivery.subscribe(async (event) => {
      // DIAGNOSTIC: Track all events in a batch to detect if WebSocket is sending them individually or together
      this.batchDeliveryEvents.push({
        timestamp: Date.now(),
        type: event.type,
        id: event.id,
        patient_name: event.data?.patient_name,
        status: event.data?.status
      });

      // Clear and log batch every 500ms to see WebSocket packet pattern
      if (this.batchTimeout) {
        clearTimeout(this.batchTimeout);
      }
      this.batchTimeout = setTimeout(() => {
        if (this.batchDeliveryEvents.length > 0) {
          console.log(`🔍 [DIAGNOSTIC] WebSocket Delivery batch (${this.batchDeliveryEvents.length} events):`);
          this.batchDeliveryEvents.forEach((e, i) => {
            console.log(`  [${i + 1}] ${e.type} - ${e.patient_name || e.id} (status: ${e.status})`);
          });
          this.batchDeliveryEvents = [];
        }
      }, 500);

      console.log(`📡 [Realtime Delivery] ${event.type}:`, event.data?.patient_name || event.id);
      console.log('📦 [Realtime Delivery] Full event:', JSON.stringify({ type: event.type, id: event.id, status: event.data?.status, isNextDelivery: event.data?.isNextDelivery, driver_id: event.data?.driver_id }, null, 2));

      // Process the event WITHOUT city filtering so new creates reach all devices immediately.
       try {
          if (event.type === 'create' || event.type === 'update') {
              // CRITICAL: Self-echo suppression — check if this WS event is an echo of a
              // local write. realtimeSync.jsx has its own suppression, but this is a SEPARATE
              // subscription that receives the same WS events without any suppression.
              // Without this, local broadcastMutation writes → server WS echoes → this
              // handler re-processes them → unnecessary IDB writes, UI flicker, and in
              // extreme cases (Start Delivery with unscoped allDeliveries) a broadcast cascade.
              const _deliveryId = event.data?.id || event.id;
              if (_deliveryId && typeof window !== 'undefined' && window.__localDeliveryWrites) {
                const _suppressTs = window.__localDeliveryWrites.get(_deliveryId);
                if (_suppressTs) {
                  // Same dual-mode semantics as realtimeSync.jsx:
                  //   1. past write timestamp (marker) -> suppress for 15s (legacy broadcastMutation)
                  //   2. future expiry timestamp -> suppress until expiry (AcceptAll/Start/terminal 90s windows)
                  // Previously only mode 2 was honored here, leaving marker-mode
                  // writes unprotected on this subscription.
                  const _now = Date.now();
                  const _isExtended = _suppressTs > _now + 1000;
                  const _suppressed = _isExtended ? (_now < _suppressTs) : (_now - _suppressTs < 15000);
                  if (_suppressed) {
                    const _remaining = _isExtended ? Math.round((_suppressTs - _now) / 1000) : Math.round((15000 - (_now - _suppressTs)) / 1000);
                    console.log(`🔇 [cityFilteredRealtimeSync] Self-echo suppressed for ${event.type}: ${event.data?.patient_name || _deliveryId} — ${_remaining}s remaining`);
                    return;
                  }
                }
              }

              console.log(`🚀 [Realtime Delivery] PROCESSING ${event.type} for ${event.data?.patient_name || event.id}`);

              const freshDelivery = event.data;
              if (!freshDelivery?.id) return;

              // CRITICAL: Content-signature guard. If another device created a
              // NEW delivery (new server ID) with the same patient_id + delivery_date
              // + store_id + driver_id as one we recently deleted, block it.
              if (event.type === 'create' && isDeletedByContent(freshDelivery)) {
                console.log(`🛡️ [cityFilteredRealtimeSync] Dropped create for new delivery ${freshDelivery.id} — content matches recently deleted delivery`);
                return;
              }

              // CRITICAL: Merge incoming WS payload with existing IDB record BEFORE saving.
              // The WS event data is PARTIAL (only changed fields). A raw bulkSave would
              // REPLACE the entire IDB record with just the changed fields, wiping out
              // status, patient_name, delivery_time_eta, encoded_polyline, and all other
              // fields that weren't in this particular WS broadcast. This was the root
              // cause of the completion revert (status='completed' wiped by a follow-up
              // WS event carrying only stop_order + isNextDelivery) and the Start Delivery
              // delay (time windows + ETA wiped by partial WS payloads).
              let mergedDelivery = freshDelivery;
              try {
                const existing = await offlineDB.getById(offlineDB.STORES.DELIVERIES, freshDelivery.id);
                if (existing) {
                  mergedDelivery = { ...existing, ...freshDelivery };
                }
                // GLOBAL TERMINAL-STICKINESS GUARD: receiving devices don't arm the
                // per-delivery completionLockout (that happens only on the device that
                // performed the Complete/Fail/Cancel). Without this guard, an interleaved
                // partial WS payload from the terminal action's multi-stream write fan-out
                // can momentarily resurrect the just-completed stop as in_transit +
                // isNextDelivery=true (the "completion bounce" seen on tablets).
                mergedDelivery = applyTerminalStatusGuard(mergedDelivery, existing);
              } catch (mergeErr) {
                console.warn('⚠️ [cityFilteredRealtimeSync] IDB merge failed, using raw payload:', mergeErr?.message);
              }

              // Save MERGED record to offline DB (preserves all existing fields)
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [mergedDelivery]);
              console.log(`✅ [Realtime Delivery] Saved to offline DB: ${mergedDelivery.patient_name || mergedDelivery.id}`);

              // ── CACHE INVALIDATION: Update window.__appDeliveries in-place ──
              // The merged record is authoritative. Update the in-memory cache so
              // subsequent UI reads (deliveriesUpdated handlers, stop card renders)
              // get fresh data, not stale snapshots that cause momentary reversion.
              if (typeof window !== 'undefined' && Array.isArray(window.__appDeliveries)) {
                // CRITICAL: Skip cache update for deleted deliveries.
                if (isDeleted(mergedDelivery.id)) {
                  console.log(`🛡️ [cityFilteredRealtimeSync] Skipping cache update for deleted delivery ${mergedDelivery.id}`);
                } else {
                  const idx = window.__appDeliveries.findIndex(d => d?.id === mergedDelivery.id);
                  if (idx !== -1) {
                    window.__appDeliveries[idx] = mergedDelivery;
                  } else {
                    window.__appDeliveries.push(mergedDelivery);
                  }
                }
              }

              // CRITICAL: Notify subscribers FIRST (AppDataContext listens for this)
              console.log(`📡 [Realtime Delivery] Notifying ${this.updateCallbacks.size} subscribers about ${event.type}`);
              this.notifySubscribers('Delivery', event.type, freshDelivery);
              this.lastDeliveryUpdate = Date.now();

              // CRITICAL: Dispatch MULTIPLE events to ensure all components update
              console.log(`📡 [Realtime Delivery] Broadcasting update to ALL UI components`);
              
              // Event 1: deliveryUpdated for specific listeners
              window.dispatchEvent(new CustomEvent('deliveryUpdated', {
                detail: { 
                  delivery: mergedDelivery,
                  deliveries: [mergedDelivery],
                  freshDeliveries: [mergedDelivery],
                  immediate: true,
                  deliveryDate: mergedDelivery.delivery_date,
                  type: event.type,
                  source: 'realtime_sync',
                  fromRealtime: true
                }
              }));
              
              // Event 2: deliveriesUpdated for map/dashboard refresh
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                detail: { 
                  deliveries: [mergedDelivery],
                  freshDeliveries: [mergedDelivery],
                  immediate: true,
                  deliveryDate: mergedDelivery.delivery_date,
                  triggeredBy: 'realtimeWebSocket',
                  source: 'realtime_sync',
                  fromRealtime: true,
                  preserveLocalState: true
                }
              }));
              
              // Event 3: Force stats refresh
              window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

              // Flash FAB only after UI had a chance to apply the delivery update.
              if (typeof window.__fabFlashUpdate === 'function') {
                requestAnimationFrame(() => requestAnimationFrame(() => window.__fabFlashUpdate()));
              }

              // CRITICAL: Trigger WebSocket reconciler (5-sec delayed safety check)
              try {
                const reconciler = await getReconciler();
                if (reconciler) {
                  reconciler.onDeliveryWebSocketEvent(mergedDelivery);
                }
              } catch (reconcilerError) {
                console.warn('⚠️ [Realtime] Reconciler trigger failed:', reconcilerError.message);
              }

              console.log(`✅ [Realtime Delivery] Complete - ${event.type} processed and broadcast to ${this.updateCallbacks.size} subscribers`);
           } else if (event.type === 'delete') {
             // Self-echo suppression for deletes (same as create/update above)
             const _deleteId = event.id;
             if (_deleteId && typeof window !== 'undefined' && window.__localDeliveryWrites) {
               const _suppressTs = window.__localDeliveryWrites.get(_deleteId);
               if (_suppressTs) {
                 const _now = Date.now();
                 const _isExtendedDel = _suppressTs > _now + 1000;
                 if (_isExtendedDel ? (_now < _suppressTs) : (_now - _suppressTs < 15000)) {
                   console.log(`🔇 [cityFilteredRealtimeSync] Self-echo suppressed for delete: ${_deleteId}`);
                   return;
                 }
               }
             }
             console.log(`🗑️ [Realtime Delivery] PROCESSING delete for ${event.id}`);

             const selectedDate = (typeof window !== 'undefined' ? window.__appSelectedDate : null) || localStorage.getItem('global_selected_date') || localStorage.getItem('app_selectedDate');
             const selectedDriverId = (typeof window !== 'undefined' ? window.__appSelectedDriverId : null) || localStorage.getItem('global_selected_driver') || localStorage.getItem('app_selectedDriver');

             // CRITICAL: Track the deleted ID on this device so future syncOnFilterChange
             // calls don't resurrect it from the server (propagation lag or another device's
             // pending mutation re-creating it). Without this, only the originating device
             // has the ID in sessionStorage.__deletedDeliveryIds — receiving devices would
             // re-save it from the next server fetch via filterChangeSync Step 3d.
             try {
               if (typeof window !== 'undefined') {
                 const _stored = JSON.parse(sessionStorage.getItem('__deletedDeliveryIds') || '[]');
                 if (!_stored.includes(event.id)) {
                   _stored.push(event.id);
                   sessionStorage.setItem('__deletedDeliveryIds', JSON.stringify(_stored));
                 }
               }
             } catch (_) { /* non-critical */ }

             // Remove from offline DB, then force a fresh reload of the selected date slice
              await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, event.id);
              console.log(`✅ [Realtime Delivery] Deleted from offline DB: ${event.id}`);

              const allSelectedDateDeliveries = selectedDate
                ? await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate)
                : await offlineDB.getAll(offlineDB.STORES.DELIVERIES);

             const scopedDeliveries = (allSelectedDateDeliveries || []).filter((delivery) => {
               if (!delivery) return false;
               if (selectedDate && delivery.delivery_date !== selectedDate) return false;
               if (selectedDriverId && selectedDriverId !== 'all') return delivery.driver_id === selectedDriverId;
               return true;
             });

             // Notify subscribers with the raw id so delete batching stays consistent
             this.notifySubscribers('Delivery', event.type, event.id);
             this.lastDeliveryUpdate = Date.now();

             // Dispatch delete events for Dashboard and overlays
             window.dispatchEvent(new CustomEvent('deliveryUpdated', {
               detail: { 
                 delivery: { id: event.id },
                 deliveries: scopedDeliveries,
                 deletedId: event.id,
                 deletedIds: [event.id],
                 deletedName: event.data?.patient_name || event.data?.patient?.full_name || null,
                 type: 'delete',
                 source: 'realtime',
                 fromRealtime: true,
                 fullReplacement: true,
                 preserveLocalState: true
               }
             }));

             window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
               detail: {
                 deliveries: scopedDeliveries,
                 freshDeliveries: scopedDeliveries,
                 deletedId: event.id,
                 deletedIds: [event.id],
                 immediate: true,
                 deliveryDate: selectedDate,
                 driverId: selectedDriverId && selectedDriverId !== 'all' ? selectedDriverId : null,
                 triggeredBy: 'realtimeWebSocket',
                 source: 'realtime_sync',
                 fromRealtime: true,
                 fullReplacement: true,
                 preserveLocalState: true
               }
             }));

             window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
           }
       } catch (error) {
         console.error('❌ [Realtime Delivery] Error processing event:', error);
       }
    });

    // Subscribe to ALL AppUser changes (filter by city only)
    this.appUserUnsubscribe = base44.entities.AppUser.subscribe(async (event) => {
      const coords = event.data ? `${event.data.current_latitude?.toFixed(6)}, ${event.data.current_longitude?.toFixed(6)}` : 'N/A';
      console.log(`📡 [Realtime AppUser] ${event.type} for ${event.data?.user_name || event.id} - coords: ${coords}, timestamp: ${event.data?.location_updated_at}`);

      // SELF-ECHO SUPPRESSION: If this AppUser update was written by THIS device
      // (tracked via window.__localAppUserWrites set in locationTrackerBroadcast),
      // suppress the WS echo — this device already has the freshest data.
      // Without this, the tablet's own heartbeat echoes (every 60s) get processed
      // and can carry stale driver_status from the server, causing marker flicker.
      if ((event.type === 'create' || event.type === 'update') && event.id) {
        const localWrites = window.__localAppUserWrites;
        if (localWrites && localWrites.has(event.id)) {
          const writtenAt = localWrites.get(event.id);
          if (Date.now() - writtenAt < 10000) {
            console.log(`🔇 [CityRealtime] Self-echo suppressed for AppUser ${event.id} — originated from this device (${Math.round((Date.now() - writtenAt) / 1000)}s ago)`);
            return;
          }
          localWrites.delete(event.id);
        }
      }

      // CRITICAL: ALWAYS dispatch appUserUpdated for ALL users so UI components
      // (DriverStatusToggle, LocationTrackingToggle) can react to their own status changes.
      // City filtering only applies to location broadcast and internal subscribers.
      if ((event.type === 'create' || event.type === 'update') && event.data) {
        window.dispatchEvent(new CustomEvent('appUserUpdated', {
          detail: { appUser: event.data, fromRealtime: true }
        }));
      }

      // Filter by the currently selected city (not user's cities) for location/dashboard updates
      // CRITICAL: Location-only WS payloads (current_latitude, current_longitude, location_updated_at)
      // do NOT include city_ids. Before the city filter, enrich event.data with the existing
      // record from window.__appUsers or IDB so city_ids is available for the filter decision.
      // Without this, location-only updates from other drivers in the same city get silently dropped.
      if (event.type !== 'delete' && event.data) {
        let _cityLookupData = event.data;
        if (!event.data.city_ids && !event.data.city_id) {
          // Try window.__appUsers first (fastest, already merged)
          if (typeof window !== 'undefined' && Array.isArray(window.__appUsers)) {
            const _cached = window.__appUsers.find(u => u?.id === event.data.id);
            if (_cached) _cityLookupData = { ..._cached, ...event.data };
          }
        }
        const appUserCityIds = _cityLookupData.city_ids || (_cityLookupData.city_id ? [_cityLookupData.city_id] : []);
        const hasMatchingCity = appUserCityIds.includes(cityId);
        
        if (!hasMatchingCity) {
          console.log(`⏭️ [Realtime AppUser] Skipping city-filtered updates - different city (user cities: ${appUserCityIds.join(',')}, current city: ${cityId})`);
          return;
        }
        // Use the enriched data downstream so the merge below has full records
        event.data = _cityLookupData;
      }

      // Process the event
      try {
        if (event.type === 'create' || event.type === 'update') {
          // Merge with existing IDB record to avoid wiping fields absent from a partial WS payload
          // (same pattern as realtimeSync.jsx AppUser merge).
          let appUserToSave = event.data;
          if (event.data?.id) {
            try {
              const existing = await offlineDB.getById(offlineDB.STORES.APP_USERS, event.data.id);
              if (existing) appUserToSave = { ...existing, ...event.data };
            } catch (_) { /* non-critical */ }
          }
          await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, [appUserToSave]);
          console.log(`✅ [Realtime AppUser] Saved ${event.data.user_name} to offline DB - coords: ${coords}`);

          // ── CACHE INVALIDATION: Update window.__appUsers in-place ──
          // Same pattern as window.__appDeliveries for Delivery events.
          // Without this, AppDataContext.flushRealtimeBatch (120ms later) reads from
          // appUsersRef.current (stale, updated by useEffect after paint) and can
          // revert location/status changes from prior WS events.
          if (typeof window !== 'undefined' && Array.isArray(window.__appUsers) && appUserToSave?.id) {
            const idx = window.__appUsers.findIndex(u => u?.id === appUserToSave.id);
            if (idx !== -1) {
              window.__appUsers[idx] = appUserToSave;
            } else {
              window.__appUsers.push(appUserToSave);
            }
          }

          // CRITICAL: Broadcast location update directly to Dashboard - ALWAYS broadcast, not just when tracking
          console.log(`📢 [Realtime AppUser] LOCATION BROADCAST - ${event.data.user_name} at ${coords} (${event.data.location_updated_at})`);
          
          // Dispatch event for Dashboard to pick up immediately
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers: [appUserToSave], fromRealtime: true, singleUpdate: true }
          }));
          
          // Notify all internal subscribers (e.g. AppDataContext)
          console.log(`📢 [Realtime AppUser] Notifying ${this.updateCallbacks.size} internal subscribers about ${event.data.user_name}`);
          this.notifySubscribers('AppUser', event.type, event.data);
          this.lastAppUserUpdate = Date.now();
        } else if (event.type === 'delete') {
          // Remove from offline DB
          await offlineDB.deleteRecord(offlineDB.STORES.APP_USERS, event.id);
          console.log(`✅ [Realtime AppUser] Deleted from offline DB: ${event.id}`);
          
          // Notify subscribers with raw id for consistent delete handling
          this.notifySubscribers('AppUser', event.type, event.id);
          this.lastAppUserUpdate = Date.now();

          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { deletedId: event.id, fromRealtime: true }
          }));
        }
      } catch (error) {
        console.error('❌ [Realtime AppUser] Error processing event:', error);
      }
    });

    // Subscribe to Patient changes for stores in the selected city
    this.patientUnsubscribe = base44.entities.Patient.subscribe(async (event) => {
      console.log(`📡 [Realtime Patient] ${event.type} for ${event.data?.full_name || event.id}`);

      // Filter patients by store city
      if (event.type !== 'delete' && event.data?.store_id) {
        try {
          // Verify the patient's store is in the selected city
          const store = await offlineDB.getById(offlineDB.STORES.STORES, event.data.store_id);
          
          if (!store || store.city_id !== cityId) {
            console.log(`⏭️ [Realtime Patient] Skipping - patient store in different city`);
            return;
          }
        } catch (error) {
          console.warn('⚠️ [Realtime Patient] Failed to check store city:', error);
        }
      }

      // Process the event
      try {
        if (event.type === 'create' || event.type === 'update') {
          // Save to offline DB
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [event.data]);
          console.log(`✅ [Realtime Patient] Saved ${event.data.full_name} to offline DB`);

          // CRITICAL: Broadcast to all devices in city
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('patientsImported', {
              detail: { 
                patients: [event.data],
                source: 'realtime'
              }
            }));
          }, 0);

          // Broadcast to all city subscribers
          this.notifySubscribers('Patient', event.type, event.data);
          this.lastPatientUpdate = Date.now();
        } else if (event.type === 'delete') {
          // Remove from offline DB
          await offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, event.id);
          console.log(`✅ [Realtime Patient] Deleted from offline DB: ${event.id}`);

          // Broadcast deletion with raw id for consistent batching
          this.notifySubscribers('Patient', event.type, event.id);
          this.lastPatientUpdate = Date.now();

          window.dispatchEvent(new CustomEvent('patientsUpdated', {
            detail: { deletedId: event.id, deletedIds: [event.id], deletedName: event.data?.full_name || null, fromRealtime: true }
          }));
        }
      } catch (error) {
        console.error('❌ [Realtime Patient] Error processing event:', error);
      }
    });

    console.log('✅ [RealtimeSync] Subscriptions active for city - broadcasting AppUser locations + Patients to all users');
  }

  /**
   * Stop all real-time subscriptions
   */
  stop() {
    if (this.deliveryUnsubscribe) {
      this.deliveryUnsubscribe();
      this.deliveryUnsubscribe = null;
    }

    if (this.appUserUnsubscribe) {
      this.appUserUnsubscribe();
      this.appUserUnsubscribe = null;
    }

    if (this.patientUnsubscribe) {
      this.patientUnsubscribe();
      this.patientUnsubscribe = null;
    }

    this.isActive = false;
    this.currentCityId = null;
    this.currentDate = null;

    console.log('🔌 [RealtimeSync] Stopped');
  }

  /**
   * Update city/date filters and restart subscriptions
   */
  updateFilters(cityId, selectedDate) {
    if (this.currentCityId === cityId && this.currentDate === selectedDate) {
      return; // No change needed
    }

    console.log(`🔄 [RealtimeSync] Updating filters: city ${this.currentCityId} → ${cityId}, date ${this.currentDate} → ${selectedDate}`);
    this.stop();
    this.start(cityId, selectedDate);
  }

  /**
   * Get time since last update for each entity type
   */
  getTimeSinceLastUpdate() {
    return {
      delivery: this.lastDeliveryUpdate ? Date.now() - this.lastDeliveryUpdate : null,
      appUser: this.lastAppUserUpdate ? Date.now() - this.lastAppUserUpdate : null,
      patient: this.lastPatientUpdate ? Date.now() - this.lastPatientUpdate : null
    };
  }
}

export const cityFilteredRealtimeSync = new CityFilteredRealtimeSync();