// cityFilteredRealtimeSync.js - Real-time subscriptions filtered by city and date

import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';

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
      console.log('⚠️ [RealtimeSync] Already active - stopping existing subscriptions first');
      this.stop();
    }

    this.currentCityId = cityId;
    this.currentDate = selectedDate;
    this.isActive = true;

    console.log(`🔌 [RealtimeSync] Starting subscriptions for city: ${cityId}`);

    // Subscribe to ALL Delivery changes (NO city filtering - process everything)
    console.log('🔌 [cityFilteredRealtimeSync] Setting up Delivery subscription - NO FILTERS');
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

      // Process the event WITHOUT any filtering
       try {
          if (event.type === 'create' || event.type === 'update') {
              console.log(`🚀 [Realtime Delivery] PROCESSING ${event.type} for ${event.data?.patient_name || event.id}`);

              // Use event data directly - don't fetch again
              const freshDelivery = event.data;

              // Save to offline DB
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [freshDelivery]);
              console.log(`✅ [Realtime Delivery] Saved to offline DB: ${freshDelivery.patient_name || freshDelivery.id}`);

              // CRITICAL: Dispatch MULTIPLE events to ensure all components update
              console.log(`📡 [Realtime Delivery] Broadcasting update to ALL UI components`);
              
              // Event 1: deliveryUpdated for specific listeners
              window.dispatchEvent(new CustomEvent('deliveryUpdated', {
                detail: { 
                  delivery: freshDelivery,
                  type: event.type,
                  source: 'realtime',
                  fromRealtime: true
                }
              }));
              
              // Event 2: deliveriesUpdated for map/dashboard refresh
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                detail: { 
                  deliveryDate: freshDelivery.delivery_date,
                  triggeredBy: 'realtimeWebSocket',
                  fromRealtime: true
                }
              }));
              
              // Event 3: Force stats refresh
              window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

              // Notify subscribers
              this.notifySubscribers('Delivery', event.type, freshDelivery);
              this.lastDeliveryUpdate = Date.now();

              console.log(`✅ [Realtime Delivery] Complete - multiple UI update events dispatched`);
           } else if (event.type === 'delete') {
             console.log(`🗑️ [Realtime Delivery] PROCESSING delete for ${event.id}`);

             // Remove from offline DB
             await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, event.id);
             console.log(`✅ [Realtime Delivery] Deleted from offline DB: ${event.id}`);

             // Notify subscribers
             this.notifySubscribers('Delivery', event.type, { id: event.id });
             this.lastDeliveryUpdate = Date.now();
           }
       } catch (error) {
         console.error('❌ [Realtime Delivery] Error processing event:', error);
       }
    });

    // Subscribe to ALL AppUser changes (filter by city only)
    this.appUserUnsubscribe = base44.entities.AppUser.subscribe(async (event) => {
      const coords = event.data ? `${event.data.current_latitude?.toFixed(6)}, ${event.data.current_longitude?.toFixed(6)}` : 'N/A';
      console.log(`📡 [Realtime AppUser] ${event.type} for ${event.data?.user_name || event.id} - coords: ${coords}, timestamp: ${event.data?.location_updated_at}`);

      // Filter by the currently selected city (not user's cities)
      if (event.type !== 'delete' && event.data) {
        const appUserCityIds = event.data.city_ids || (event.data.city_id ? [event.data.city_id] : []);
        const hasMatchingCity = appUserCityIds.includes(cityId);
        
        if (!hasMatchingCity) {
          console.log(`⏭️ [Realtime AppUser] Skipping - different city (user cities: ${appUserCityIds.join(',')}, current city: ${cityId})`);
          return;
        }
      }

      // Process the event
      try {
        if (event.type === 'create' || event.type === 'update') {
          // Save to offline DB
          await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, [event.data]);
          console.log(`✅ [Realtime AppUser] Saved ${event.data.user_name} to offline DB - coords: ${coords}`);
          
          // CRITICAL: Broadcast location update directly to Dashboard - ALWAYS broadcast, not just when tracking
          console.log(`📢 [Realtime AppUser] LOCATION BROADCAST - ${event.data.user_name} at ${coords} (${event.data.location_updated_at})`);
          
          // Dispatch event for Dashboard to pick up immediately
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers: [event.data], fromRealtime: true, singleUpdate: true }
          }));
          
          // CRITICAL: Also dispatch generic AppUser update for UI components
          window.dispatchEvent(new CustomEvent('appUserUpdated', {
            detail: { appUser: event.data, fromRealtime: true }
          }));
          
          // Notify all internal subscribers (e.g. AppDataContext)
          console.log(`📢 [Realtime AppUser] Notifying ${this.updateCallbacks.size} internal subscribers about ${event.data.user_name}`);
          this.notifySubscribers('AppUser', event.type, event.data);
          this.lastAppUserUpdate = Date.now();
        } else if (event.type === 'delete') {
          // Remove from offline DB
          await offlineDB.deleteRecord(offlineDB.STORES.APP_USERS, event.id);
          console.log(`✅ [Realtime AppUser] Deleted from offline DB: ${event.id}`);
          
          // Notify subscribers
          this.notifySubscribers('AppUser', event.type, { id: event.id });
          this.lastAppUserUpdate = Date.now();
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

          // Broadcast deletion
          this.notifySubscribers('Patient', event.type, { id: event.id });
          this.lastPatientUpdate = Date.now();
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