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
    // TWO-STAGE BEHAVIOR:
    // ACTIVE ROUTE: Show breadcrumbs + polylines together
    // COMPLETED ROUTE: Toggle between polylines-only OR breadcrumbs-only

    const isActiveRoute = !isRouteComplete;

    if (isActiveRoute) {
      // Active route: load breadcrumbs and show them alongside polylines
      const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
      const driverIdToFetch = selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
      const loadedBreadcrumbs = await loadBreadcrumbsForDriver(driverIdToFetch, selectedDateStr, appUsers);

      if (loadedBreadcrumbs.historical.length === 0 && loadedBreadcrumbs.current.length === 0) {
        toast.info('No breadcrumb trails available', { description: 'GPS trails appear after a stop is finished with tracking on' });
        return;
      }

      setBreadcrumbsData(loadedBreadcrumbs);
      setShowBreadcrumbs(true);
      setShowRoutes(true); // Keep polylines visible
      return;
    }

    // Completed route: toggle between polylines OR breadcrumbs
    if (showBreadcrumbs) {
      // Currently showing breadcrumbs → switch to polylines
      setShowBreadcrumbs(false);
      setBreadcrumbsData({ historical: [], current: [] });
      setShowRoutes(true);
      return;
    }

    // Currently showing polylines → switch to breadcrumbs
    const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
    const driverIdToFetch = selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
    const loadedBreadcrumbs = await loadBreadcrumbsForDriver(driverIdToFetch, selectedDateStr, appUsers);

    if (loadedBreadcrumbs.historical.length === 0 && loadedBreadcrumbs.current.length === 0) {
      toast.info('No breadcrumb trails available', { description: 'GPS trails appear after a stop is finished with tracking on' });
      return;
    }

    setBreadcrumbsData(loadedBreadcrumbs);
    setShowBreadcrumbs(true);
    setShowRoutes(false);
  };

  const isActiveRoute = !isRouteComplete;
  const showsBoth = isActiveRoute && showBreadcrumbs;

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={handleClick}
      className={`h-9 w-9 p-0 ${showsBoth ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : showBreadcrumbs ? 'bg-blue-600 hover:bg-blue-700 text-white' : ''}`}
      style={!showBreadcrumbs && !showsBoth ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-700)' } : {}}
      title={isActiveRoute ? 'Show breadcrumbs + polylines' : showBreadcrumbs ? 'Switch to polylines' : 'Switch to breadcrumbs'}
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