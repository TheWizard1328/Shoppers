import React from "react";
import StopCardActionButtons from "./StopCardActionButtons";

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
    isStrippedForDispatcher
  } = props;

  const dispatcherStoreIds = Array.isArray(currentUser?.store_ids) ? currentUser.store_ids : [];
  const finishedStatuses = ['completed', 'cancelled', 'failed', 'returned'];
  const selectedDriverId = props?.delivery?.driver_id;
  const selectedDate = props?.delivery?.delivery_date;
  const allDeliveries = Array.isArray(props?.allDeliveries) ? props.allDeliveries : [];
  const isDispatcherOnly = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') && !isAppOwner(currentUser);
  const dispatcherRouteStops = isDispatcherOnly
    ? allDeliveries.filter((item) => item && item.driver_id === selectedDriverId && item.delivery_date === selectedDate && dispatcherStoreIds.includes(item.store_id))
    : [];
  const hasIncompleteStopsForDispatcher = dispatcherRouteStops.some((item) => !finishedStatuses.includes(item?.status));

  const shouldShowFooter = (() => {
    if (shouldCondenseCompletedRouteForDriver) return false;
    if (!isAppOwner(currentUser) && !userHasRole(currentUser, 'admin') && isStrippedForDispatcher) return false;
    if (isDispatcherOnly) return false;
    if (isExpanded) return true;
    return isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || isAssignedDriverOrAppOwner || canEdit;
  })();

  if (!shouldShowFooter) return null;

  return (
    <div>
      <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
        <div className={`mx-1 flex justify-between items-center ${showCenteredIncompleteCollapsed ? 'mt-1 mb-0' : 'my-1'}`}>
          <StopCardActionButtons {...props} />
        </div>
      </div>
    </div>
  );
}