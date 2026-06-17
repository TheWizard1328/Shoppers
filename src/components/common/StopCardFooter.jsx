import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, XCircle } from "lucide-react";
import StopCardActionButtons from "./StopCardActionButtons";
import { cancelPickupForDispatcher } from "./cancelPickupForDispatcher";

export default function StopCardFooter(props) {
  const {
    shouldAnchorExpandedCard,
    showCenteredIncompleteCollapsed,
    shouldCondenseCompletedRouteForDriver,
    isAppOwner,
    userHasRole,
    currentUser,
    isAssignedDriverOrAppOwner,
    canEdit,
    isExpanded,
    isStrippedForDispatcher,
    delivery,
    isPickup,
    store,
    appUsers,
  } = props;

  const [isCancelling, setIsCancelling] = useState(false);

  const dispatcherStoreIds = Array.isArray(currentUser?.store_ids) ? currentUser.store_ids : [];
  const finishedStatuses = ['completed', 'cancelled', 'failed', 'returned'];
  const selectedDriverId = delivery?.driver_id;
  const selectedDate = delivery?.delivery_date;
  const allDeliveries = Array.isArray(props?.allDeliveries) ? props.allDeliveries : [];
  const isDispatcherOnly = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') && !isAppOwner(currentUser);
  const dispatcherRouteStops = isDispatcherOnly ?
    allDeliveries.filter((item) => item && item.driver_id === selectedDriverId && item.delivery_date === selectedDate && dispatcherStoreIds.includes(item.store_id)) :
    [];
  const hasIncompleteStopsForDispatcher = dispatcherRouteStops.some((item) => !finishedStatuses.includes(item?.status));

  // Show Cancel Pickup button for dispatchers on active, non-finished pickup cards,
  // BUT hide it if any deliveries with a matching puid are still pending or in_transit
  const isActivePickup = isPickup && delivery && !finishedStatuses.includes(delivery.status);
  const pickupPuid = delivery?.stop_id || delivery?.puid;
  const hasActiveLinkedDeliveries = pickupPuid
    ? allDeliveries.some((d) =>
        d &&
        d.id !== delivery?.id &&
        (d.puid === pickupPuid || d.stop_id === pickupPuid) &&
        (d.status === 'pending' || d.status === 'in_transit' || d.status === 'en_route')
      )
    : false;
  const showCancelPickupButton = isDispatcherOnly && isActivePickup && !hasActiveLinkedDeliveries;

  const shouldShowFooter = (() => {
    if (shouldCondenseCompletedRouteForDriver) return false;
    if (!isAppOwner(currentUser) && !userHasRole(currentUser, 'admin') && isStrippedForDispatcher) return false;
    if (isDispatcherOnly) return showCancelPickupButton; // show footer only for the Cancel Pickup button
    if (isExpanded) return true;
    return isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || isAssignedDriverOrAppOwner || canEdit;
  })();

  if (!shouldShowFooter) return null;

  const handleCancelPickup = async (e) => {
    e.stopPropagation();
    if (isCancelling) return;
    setIsCancelling(true);
    try {
      await cancelPickupForDispatcher({ delivery, store, appUsers, currentUser });
    } finally {
      setIsCancelling(false);
    }
  };

  // Dispatcher-only view: just show the Cancel Pickup button
  if (isDispatcherOnly && showCancelPickupButton) {
    return (
      <div>
        <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
          <div className="mx-1 flex justify-end items-center mt-1 mb-0.5">
            <Button
              type="button"
              size="sm"
              disabled={isCancelling}
              onClick={handleCancelPickup}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              className="bg-red-600 hover:bg-red-700 text-white h-10 px-4 text-sm font-medium"
            >
              {isCancelling
                ? <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                : <XCircle className="w-4 h-4 mr-1" />}
              Cancel Pickup
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
        <div className="mx-1 flex justify-between items-center mt-1 mb-0.5">
          <StopCardActionButtons {...props} />
        </div>
      </div>
    </div>
  );
}