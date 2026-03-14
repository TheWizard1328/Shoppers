import React from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { loadBreadcrumbsForDriver } from "@/components/utils/breadcrumbsManager";

export default function BreadcrumbToggleButton({
  isMobile,
  isDriver,
  isRouteComplete,
  showBreadcrumbs,
  setShowBreadcrumbs,
  setShowRoutes,
  setBreadcrumbsData,
  selectedDate,
  showAllDriverMarkers,
  selectedDriverId,
  currentUser,
  appUsers
}) {
  const handleClick = async () => {
    const isExclusiveCompletedRouteToggle = isMobile && isDriver && isRouteComplete;

    if (isExclusiveCompletedRouteToggle && showBreadcrumbs) {
      setShowBreadcrumbs(false);
      setBreadcrumbsData({ historical: [], current: [] });
      setShowRoutes(true);
      return;
    }

    const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
    const driverIdToFetch = (showAllDriverMarkers || selectedDriverId === 'all') ? currentUser?.id : selectedDriverId;
    const loadedBreadcrumbs = await loadBreadcrumbsForDriver(driverIdToFetch, selectedDateStr, appUsers);

    if (loadedBreadcrumbs.historical.length === 0 && loadedBreadcrumbs.current.length === 0) {
      toast.info('No breadcrumb trails available', { description: 'GPS trails appear after a stop is finished with tracking on' });
      setShowBreadcrumbs(false);
      if (isExclusiveCompletedRouteToggle) setShowRoutes(true);
      return;
    }

    setBreadcrumbsData(loadedBreadcrumbs);

    if (isExclusiveCompletedRouteToggle) {
      setShowBreadcrumbs(true);
      setShowRoutes(false);
      return;
    }

    setShowBreadcrumbs(!showBreadcrumbs);
  };

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={handleClick}
      className={`h-9 w-9 p-0 ${showBreadcrumbs ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
      style={!showBreadcrumbs ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)' } : {}}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="3" r="1.5" fill="currentColor" />
        <circle cx="4" cy="8" r="1.5" fill="currentColor" />
        <circle cx="12" cy="9" r="1.5" fill="currentColor" />
        <circle cx="8" cy="13" r="1.5" fill="currentColor" />
        <path d="M 8 3 Q 6 5, 4 8" stroke="currentColor" strokeWidth="1" fill="none" />
        <path d="M 4 8 Q 8 8.5, 12 9" stroke="currentColor" strokeWidth="1" fill="none" />
        <path d="M 12 9 Q 10 11, 8 13" stroke="currentColor" strokeWidth="1" fill="none" />
      </svg>
    </Button>
  );
}