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

  const shouldShowFooter = (() => {
    if (shouldCondenseCompletedRouteForDriver) return false;
    if (userHasRole(currentUser, 'dispatcher') && !isExpanded) return false;
    if (!isAppOwner(currentUser) && !userHasRole(currentUser, 'admin') && isStrippedForDispatcher) return false;
    if (isExpanded) return true;
    return isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || isAssignedDriverOrAppOwner || canEdit;
  })();

  if (!shouldShowFooter) return null;

  return (
    <div className={shouldAnchorExpandedCard ? 'sticky bottom-0 z-10' : ''} style={shouldAnchorExpandedCard ? { background: 'var(--bg-white)' } : undefined}>
      <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
        <div className={`mx-1 flex justify-between items-center ${showCenteredIncompleteCollapsed ? 'mt-1 mb-0' : 'my-1'}`}>
          <StopCardActionButtons {...props} />
        </div>
      </div>
    </div>
  );
}