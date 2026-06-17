import React from 'react';
import { useDevice } from '@/components/utils/DeviceContext';
import OfflineSyncIndicator from '../layout/OfflineSyncIndicator';

// Rendered INSIDE the expanded stats card body (mobile + centered desktop).
// Uses renderInline=true so the dropdown expands as an accordion below the button,
// rather than floating with position:absolute which gets clipped by the card.
export default function DashboardOfflineSync({ currentUser, dailyPolylineCount, isExpanded }) {
  const { isMobile } = useDevice();

  // On mobile, only show when stats card is expanded
  if (isMobile && !isExpanded) return null;

  return (
    <div className="w-full">
      <OfflineSyncIndicator renderInline={true} />
    </div>
  );
}
