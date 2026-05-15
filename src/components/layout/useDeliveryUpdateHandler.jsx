import { useEffect } from 'react';

/**
 * Handles 'deliveriesUpdated' events and ensures offline DB stays in sync before UI updates
 */
export const useDeliveryUpdateHandler = ({
  isUiLocked,
  isFormOverlayOpen,
  deliveries,
  setDeliveries,
  offlineDB
}) => {
  useEffect(() => {
    const handleDeliveriesUpdated = async (event) => {
      // CRITICAL: Ignore intermediate events while filter-change sync is running
      if (isUiLocked()) {
        console.log('🔒 [Layout] deliveriesUpdated ignored — UI locked during filter-change sync');
        return;
      }
      
      const { 
        deliveryId, 
        driverId, 
        deliveryDate, 
        triggeredBy, 
        freshDeliveries, 
        preserveLocalState, 
        deletedIds, 
        deletedId, 
        fullReplacement 
      } = event.detail || {};
      
      const skipReloadTriggers = ['batchSaveImmediate', 'driver_location_update', 'driverLocationUpdate', 'pullToSyncDataReady', 'pullToSyncComplete', 'initialDataReady'];
      
      if (preserveLocalState || skipReloadTriggers.includes(triggeredBy)) {
        // CRITICAL: Always remove deleted IDs even when preserving local state
        const idsToRemove = new Set([...(deletedIds || []), ...(deletedId ? [deletedId] : [])]);
        if (idsToRemove.size > 0) setDeliveries((prev) => prev.filter((d) => !idsToRemove.has(d?.id)));
        if (freshDeliveries?.length > 0) {
          setDeliveries((prev) => {
            const map = new Map(prev.filter((d) => !idsToRemove.has(d?.id)).map((d) => [d?.id, d]).filter(([id]) => !!id));
            freshDeliveries.forEach((d) => {
              if (d?.id && !idsToRemove.has(d.id)) map.set(d.id, d);
            });
            return Array.from(map.values());
          });
        }
        return;
      }
      
      console.log(`🔄 [Layout] Delivery updated event: ${deliveryId} (${triggeredBy}) - fullReplacement: ${fullReplacement}`);
      
      if (freshDeliveries?.length > 0) {
        // CRITICAL: Save to offline DB FIRST before updating UI
        if (deliveryDate) {
          try {
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
            console.log(`✅ [Layout] Offline DB synced: ${freshDeliveries.length} deliveries for ${deliveryDate}`);
          } catch (err) {
            console.warn(`⚠️ [Layout] Offline DB sync failed:`, err?.message || err);
            // Continue anyway — offline update shouldn't block UI update
          }
        }
        
        // CRITICAL: When fullReplacement is true (route optimization), replace entire array to preserve stop_order
        if (fullReplacement) {
          setDeliveries((prev) => [...freshDeliveries].filter(Boolean));
        } else {
          // Merge mode for partial updates
          setDeliveries((prev) => {
            const map = new Map((prev || []).filter(Boolean).map((d) => [d?.id, d]).filter(([id]) => !!id));
            freshDeliveries.forEach((d) => {
              if (d?.id) map.set(d.id, d);
            });
            return Array.from(map.values());
          });
        }
      }
    };
    
    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdated);
    
    return () => {
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdated);
    };
  }, [isUiLocked, isFormOverlayOpen, deliveries, setDeliveries, offlineDB]);
};