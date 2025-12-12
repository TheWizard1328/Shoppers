import React from 'react';
import OfflineSyncIndicator from '../layout/OfflineSyncIndicator';
import { isAppOwner } from '../utils/userRoles';
import { isMobileDevice } from '../utils/deviceUtils';

export default function DashboardOfflineSync({ currentUser, dailyPolylineCount, isExpanded }) {
  const isMobile = isMobileDevice();

  if (isMobile) {
    // Mobile: always render in expanded stats card
    if (!isExpanded) return null;
    return <OfflineSyncIndicator inline={true} />;
  }

  // Desktop: show in upper-left corner below polyline counter
  const hasPolylineCounter = currentUser && isAppOwner(currentUser) && dailyPolylineCount !== null;
  return (
    <div className={`absolute left-2 z-[999] ${hasPolylineCounter ? 'top-14' : 'top-2'}`}>
      <OfflineSyncIndicator inline={true} />
    </div>
  );
}