import React from 'react';
import OfflineSyncIndicator from '../layout/OfflineSyncIndicator';
import { isMobileDevice } from '../utils/deviceUtils';

export default function DashboardOfflineSync({ currentUser, dailyPolylineCount, isExpanded, stopCardsHeight = 75 }) {
  const isMobile = isMobileDevice();

  if (isMobile) {
    // Mobile: always render in expanded stats card
    if (!isExpanded) return null;
    return <OfflineSyncIndicator inline={true} />;
  }

  // Desktop: positioned next to stats card (aligned at top)
  return (
    <div className="absolute top-2 z-[600]" style={{ left: 'calc(2rem + 340px + 0.5rem)' }}>
      <OfflineSyncIndicator inline={true} />
    </div>
  );
}