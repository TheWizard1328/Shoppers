import { useEffect } from 'react';
import { format } from 'date-fns';
import { driverLocationPoller } from '@/components/utils/driverLocationPoller';

/**
 * Apply a pull-to-sync data result to dashboard state (deliveries + appUsers)
 * and tell downstream systems to recompute stats. Extracted from Dashboard.jsx.
 *
 * @param {{ selectedDate: Date, updateDeliveriesLocally: Function, updateAppUsersLocally: Function, deliveries: any[], drivers: any[], stores: any[], showAllDriverMarkers: boolean, selectedDriverId: string, currentUser: object, currentUserId: string, appUsers: any[], setCurrentToNextPolyline?: Function, setDriverRoutes?: Function }} deps
 */
export function usePullToSyncDataReadyEffect({
  selectedDate, updateDeliveriesLocally, updateAppUsersLocally,
  deliveries, drivers, stores, showAllDriverMarkers, selectedDriverId,
  currentUser, setCurrentToNextPolyline, setDriverRoutes,
}) {
  useEffect(() => {
    const handlePullToSyncDataReady = async (event) => {
      const {
        deliveries: freshDeliveries,
        appUsers: freshAppUsers,
      } = event.detail || {};
      try {
        if (setCurrentToNextPolyline) setCurrentToNextPolyline(null);
        if (setDriverRoutes) setDriverRoutes([]);
        if (updateDeliveriesLocally && freshDeliveries) {
          const _sd = freshDeliveries[0]?.delivery_date, _si = new Set(freshDeliveries.map((d) => d?.id).filter(Boolean));
          updateDeliveriesLocally([...deliveries.filter((d) => d && (d.delivery_date !== _sd || !_si.has(d.id))), ...freshDeliveries], true);
        }
        if (updateAppUsersLocally && freshAppUsers) { updateAppUsersLocally(freshAppUsers, true); }

        const validAppUsers = (freshAppUsers || []).filter((u) => u?.user_id && u.user_id !== 'undefined' && u?.user_name && u.user_name !== 'undefined');
        const appUsersForPoller = validAppUsers.length > 0 ? validAppUsers : [];

        if (appUsersForPoller && appUsersForPoller.length > 0) {
          driverLocationPoller.processLocationData(currentUser, freshDeliveries || [], drivers, stores, appUsersForPoller, selectedDate, true, 'Dashboard', showAllDriverMarkers || selectedDriverId === 'all');
        }

        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryDate: format(selectedDate, 'yyyy-MM-dd'), triggeredBy: 'pullToSyncDataReady', forceFullUpdate: true } }));
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      } catch (error) { console.error('❌ [Dashboard] Pull to sync update failed:', error); }
    };
    window.addEventListener('pullToSyncDataReady', handlePullToSyncDataReady);
    return () => window.removeEventListener('pullToSyncDataReady', handlePullToSyncDataReady);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateDeliveriesLocally, updateAppUsersLocally, selectedDate, drivers, stores, showAllDriverMarkers, selectedDriverId, currentUser, setCurrentToNextPolyline, setDriverRoutes]);
}