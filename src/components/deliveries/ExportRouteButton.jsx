import React, { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Download, ChevronDown } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { format } from "date-fns";
import { userHasRole } from "../utils/userRoles";

export default function ExportRouteButton({ currentUser, driverFilter, selectedDate, driverFilteredDeliveries }) {
  const finishedStatuses = ['completed','failed','cancelled','returned','picked_up'];
  const allDeliveries = driverFilteredDeliveries || [];

  // Dispatcher's store IDs
  const dispatcherStoreIds = useMemo(() => {
    if (!currentUser?.store_ids) return [];
    return currentUser.store_ids;
  }, [currentUser?.store_ids]);

  const isDispatcherOnly = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
  const isAdmin = userHasRole(currentUser, 'admin');
  const isDriver = userHasRole(currentUser, 'driver') && !isAdmin && !userHasRole(currentUser, 'dispatcher');

  // For dispatchers: filter to only their store's stops
  const dispatcherStoreDeliveries = useMemo(() => {
    if (!isDispatcherOnly || dispatcherStoreIds.length === 0) return allDeliveries;
    return allDeliveries.filter(d => d && dispatcherStoreIds.includes(d.store_id));
  }, [allDeliveries, isDispatcherOnly, dispatcherStoreIds]);

  // Route complete check (all stops finished)
  const isRouteComplete = allDeliveries.length > 0 &&
    allDeliveries.every(d => d && finishedStatuses.includes(d.status));

  // Dispatcher: all of THEIR store's stops finished
  const isDispatcherRouteComplete = dispatcherStoreDeliveries.length > 0 &&
    dispatcherStoreDeliveries.every(d => d && finishedStatuses.includes(d.status));

  // Dispatcher AM/PM qualification logic:
  // A period qualifies if there's a pickup (no patient_id) for dispatcher's store
  // that is 'en_route' AND there are pending stops with matching puid
  const getPeriodQualification = (period) => {
    if (!isDispatcherOnly) return false;
    // Find pickups for dispatcher's stores in this period that are en_route
    const enRoutePickups = dispatcherStoreDeliveries.filter(d =>
      d && !d.patient_id &&
      d.ampm_deliveries === period &&
      d.status === 'en_route'
    );
    if (enRoutePickups.length === 0) return false;

    // Check if there are pending stops attached to these pickups (matching puid = pickup's stop_id)
    const pickupStopIds = enRoutePickups.map(p => p.stop_id).filter(Boolean);
    const hasPendingStops = dispatcherStoreDeliveries.some(d =>
      d && d.patient_id && d.status === 'pending' &&
      pickupStopIds.includes(d.puid)
    );
    return hasPendingStops;
  };

  const amQualified = getPeriodQualification('AM');
  const pmQualified = getPeriodQualification('PM');
  const qualifiedCount = (amQualified ? 1 : 0) + (pmQualified ? 1 : 0);

  const handleExport = async (type, ampm) => {
    const driverId = driverFilter;
    if (!driverId || driverId === 'all') { alert('Select a driver first'); return; }
    const dateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd');

    const payload = {
      driverId,
      deliveryDate: dateStr,
      manifestType: type,
      ampm: type === 'pre-route' ? ampm : undefined,
      // Dispatchers: only export their store's stops
      storeIds: isDispatcherOnly ? dispatcherStoreIds : undefined
    };

    const res = await base44.functions.invoke('generateRouteManifest', payload);
    const data = res?.data || res;

    if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !('byteLength' in (data || {}))) {
      if (data?.error) { alert(data.error); return; }
    }

    const blob = new Blob([data], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `route-${type}${ampm ? `-${ampm}` : ''}-${dateStr}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // === DRIVERS & ADMINS: Post-route only, enabled when route complete ===
  if (isDriver || isAdmin) {
    const btnDisabled = !isRouteComplete || driverFilter === 'all' || allDeliveries.length === 0;
    return (
      <Button
        onClick={() => handleExport('post-route')}
        className="bg-emerald-600 hover:bg-emerald-700 gap-2"
        disabled={btnDisabled}
      >
        <Download className="w-4 h-4" />
        Export Route
      </Button>
    );
  }

  // === DISPATCHERS ===
  if (isDispatcherOnly) {
    const noDriver = driverFilter === 'all';
    const noStoreDeliveries = dispatcherStoreDeliveries.length === 0;

    // If all dispatcher's store stops are finished → post-route export
    if (isDispatcherRouteComplete) {
      return (
        <Button
          onClick={() => handleExport('post-route')}
          className="bg-emerald-600 hover:bg-emerald-700 gap-2"
          disabled={noDriver || noStoreDeliveries}
        >
          <Download className="w-4 h-4" />
          Export Route
        </Button>
      );
    }

    // Both AM and PM qualify → show dropdown
    if (qualifiedCount === 2) {
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="gap-2" disabled={noDriver}>
              <Download className="w-4 h-4" />
              Export Route
              <ChevronDown className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => handleExport('pre-route', 'AM')}>
              Export AM
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExport('pre-route', 'PM')}>
              Export PM
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    // Only one period qualifies → single button (no dropdown)
    if (qualifiedCount === 1) {
      const qualifiedPeriod = amQualified ? 'AM' : 'PM';
      return (
        <Button
          onClick={() => handleExport('pre-route', qualifiedPeriod)}
          variant="outline"
          className="gap-2"
          disabled={noDriver}
        >
          <Download className="w-4 h-4" />
          Export Route
        </Button>
      );
    }

    // No period qualifies → disabled button
    return (
      <Button variant="outline" className="gap-2" disabled>
        <Download className="w-4 h-4" />
        Export Route
      </Button>
    );
  }

  return null;
}