import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import ExportRouteEmailDialog from "./ExportRouteEmailDialog";
import { format } from "date-fns";
import { userHasRole } from "../utils/userRoles";
import { globalFilters } from "@/components/utils/globalFilters";

export default function ExportRouteButton({ currentUser, driverFilter, selectedDate, driverFilteredDeliveries }) {
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned', 'picked_up'];
  const allDeliveries = driverFilteredDeliveries || [];

  const dateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null;

  const dayDeliveries = useMemo(() => {
    if (!dateStr) return [];
    return allDeliveries.filter((d) => d && d.delivery_date === dateStr);
  }, [allDeliveries, dateStr]);

  // Dispatcher's store IDs
  const dispatcherStoreIds = useMemo(() => {
    if (!currentUser?.store_ids) return [];
    return currentUser.store_ids;
  }, [currentUser?.store_ids]);

  const isDispatcherOnly = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
  const isAdmin = userHasRole(currentUser, 'admin');
  const isDriver = userHasRole(currentUser, 'driver') && !isAdmin && !userHasRole(currentUser, 'dispatcher');
  const selectedCityId = globalFilters.getSelectedCityId();
  const [dispatcherAllDateDeliveries, setDispatcherAllDateDeliveries] = useState([]);

  useEffect(() => {
    let isActive = true;
    if (!isDispatcherOnly || !dateStr) {
      setDispatcherAllDateDeliveries([]);
      return () => {
        isActive = false;
      };
    }

    base44.entities.Delivery.filter({ delivery_date: dateStr }).then((deliveries) => {
      if (isActive) {
        setDispatcherAllDateDeliveries(deliveries || []);
      }
    });

    return () => {
      isActive = false;
    };
  }, [isDispatcherOnly, dateStr, selectedCityId]);

  // For dispatchers: filter to only their store's stops across all drivers for the selected date
  const dispatcherDayDeliveries = useMemo(() => {
    const source = isDispatcherOnly ? dispatcherAllDateDeliveries : dayDeliveries;
    if (!isDispatcherOnly || dispatcherStoreIds.length === 0) return source;
    return source.filter((d) => d && dispatcherStoreIds.includes(d.store_id));
  }, [dayDeliveries, isDispatcherOnly, dispatcherStoreIds, dispatcherAllDateDeliveries]);

  // Route complete check (all stops finished for selected date)
  const isRouteComplete = dayDeliveries.length > 0 &&
  dayDeliveries.every((d) => d && finishedStatuses.includes(d.status));

  // Dispatcher: all of THEIR store's stops finished
  const isDispatcherRouteComplete = dispatcherDayDeliveries.length > 0 &&
  dispatcherDayDeliveries.every((d) => d && finishedStatuses.includes(d.status));

  // Dispatcher AM/PM qualification logic:
  // A period qualifies if there's a pickup (no patient_id) for dispatcher's store
  // that is 'en_route' AND there are pending stops with matching puid
  const getPeriodQualification = (period) => {
    if (!isDispatcherOnly) return false;
    // Find pickups for dispatcher's stores in this period that are en_route
    const enRoutePickups = dispatcherDayDeliveries.filter((d) =>
    d && !d.patient_id &&
    d.ampm_deliveries === period &&
    d.status === 'en_route'
    );
    if (enRoutePickups.length === 0) return false;

    // Check if there are pending stops attached to these pickups (matching puid = pickup's stop_id)
    const pickupStopIds = enRoutePickups.map((p) => p.stop_id).filter(Boolean);
    const hasPendingStops = dispatcherDayDeliveries.some((d) =>
    d && d.patient_id && d.status === 'pending' &&
    pickupStopIds.includes(d.puid)
    );
    return hasPendingStops;
  };

  const amQualified = getPeriodQualification('AM');
  const pmQualified = getPeriodQualification('PM');
  const qualifiedCount = (amQualified ? 1 : 0) + (pmQualified ? 1 : 0);

  const [isExporting, setIsExporting] = useState(false);
  const [isEmailDialogOpen, setIsEmailDialogOpen] = useState(false);
  const driverStoreIds = useMemo(() => [...new Set(dayDeliveries.map((d) => d?.store_id).filter(Boolean))], [dayDeliveries]);

  const getDriverNamesForSubject = (deliveries) => {
    const names = [...new Set((deliveries || []).map((delivery) => delivery?.driver_name || delivery?.driver_id).filter(Boolean))];
    return names.length > 0 ? names.join(', ') : 'Unassigned';
  };

  const handleDispatcherEmailExport = async ({ recipientEmails }) => {
    if (isExporting || !recipientEmails?.length) return;
    setIsExporting(true);
    try {
      const exportConfig = isDispatcherRouteComplete ?
      { manifestType: 'post-route' } :
      qualifiedCount > 0 ?
      { manifestType: 'pre-route', ampm: qualifiedPeriod } :
      null;

      if (!exportConfig) return;

      const exportDate = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd');
      const relevantDeliveries = exportConfig.manifestType === 'post-route' ?
      dispatcherDayDeliveries :
      dispatcherDayDeliveries.filter((d) => d && d.ampm_deliveries === exportConfig.ampm && !finishedStatuses.includes(d.status));
      const driverNames = getDriverNamesForSubject(relevantDeliveries);
      const validRecipientEmails = [...new Set((recipientEmails || []).map((email) => typeof email === 'string' ? email.trim().toLowerCase() : '').filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];

      if (validRecipientEmails.length === 0) {
        alert('Please add at least one valid email address.');
        return;
      }

      const res = await base44.functions.invoke('generateRouteManifest', {
        deliveryDate: exportDate,
        manifestType: exportConfig.manifestType,
        ampm: exportConfig.manifestType === 'pre-route' ? exportConfig.ampm : undefined,
        storeIds: dispatcherStoreIds,
        selectedCityId,
        recipientEmails: validRecipientEmails,
        emailSubject: `Route logs for: ${driverNames} ${exportDate}`
      });
      const data = res?.data || res;

      if (data?.error) {
        alert(data.error);
        return;
      }

      alert('Route log emailed successfully.');
    } catch (error) {
      alert(error?.response?.data?.error || error?.message || 'Route email export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleDriverEmailExport = async ({ recipientEmails, perStoreEmails }) => {
    if (isExporting || !recipientEmails?.length) return;
    setIsExporting(true);
    try {
      const exportDate = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd');
      const validRecipientEmails = [...new Set((recipientEmails || []).map((email) => typeof email === 'string' ? email.trim().toLowerCase() : '').filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];

      if (validRecipientEmails.length === 0) {
        alert('Please add at least one valid email address.');
        return;
      }

      const driverNames = getDriverNamesForSubject(dayDeliveries);
      const emailJobs = [
        base44.functions.invoke('generateRouteManifest', {
          driverId: driverFilter,
          deliveryDate: exportDate,
          manifestType: 'post-route',
          recipientEmails: validRecipientEmails,
          emailSubject: `Route logs for: ${driverNames} ${exportDate}`
        })
      ];

      driverStoreIds.forEach((storeId) => {
        const storeRecipientEmails = [...new Set(((perStoreEmails?.[storeId]) || []).map((email) => typeof email === 'string' ? email.trim().toLowerCase() : '').filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
        if (storeRecipientEmails.length === 0) return;

        emailJobs.push(
          base44.functions.invoke('generateRouteManifest', {
            driverId: driverFilter,
            deliveryDate: exportDate,
            manifestType: 'post-route',
            storeIds: [storeId],
            recipientEmails: storeRecipientEmails,
            emailSubject: `Route logs for: ${driverNames} ${exportDate} (${storeId})`
          })
        );
      });

      const results = await Promise.all(emailJobs);
      const failedResult = results.map((res) => res?.data || res).find((data) => data?.error);
      if (failedResult?.error) {
        alert(failedResult.error);
        return;
      }

      alert('Route logs emailed successfully.');
    } catch (error) {
      alert(error?.response?.data?.error || error?.message || 'Route email export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExport = async (type, ampm) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const exportAllDispatcherDrivers = isDispatcherOnly;
      const driverId = exportAllDispatcherDrivers ? undefined : driverFilter;
      if (!driverId && !exportAllDispatcherDrivers) {alert('Select a driver first');return;}
      const dateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd');

      const payload = {
        driverId,
        deliveryDate: dateStr,
        manifestType: type,
        ampm: type === 'pre-route' ? ampm : undefined,
        // Dispatchers: only export their store's stops
        storeIds: isDispatcherOnly ? dispatcherStoreIds : undefined,
        selectedCityId: isDispatcherOnly ? selectedCityId : undefined
      };

      const res = await base44.functions.invoke('generateRouteManifest', payload);
      const data = res?.data || res;

      if (data && typeof data === 'object' && !(data instanceof ArrayBuffer) && !('byteLength' in (data || {}))) {
        if (data?.error) {alert(data.error);return;}
      }

      const blob = new Blob([data], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${type}${ampm ? `-${ampm}` : ''}-${dateStr}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  // === DRIVERS: Email full route + per-store route PDFs ===
  if (isDriver) {
    const btnDisabled = !dateStr || !isRouteComplete || driverFilter === 'all' || dayDeliveries.length === 0 || driverStoreIds.length === 0;
    return (
      <>
        <div className="my-2 w-full flex justify-center">
          <Button
            onClick={() => setIsEmailDialogOpen(true)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
            disabled={btnDisabled || isExporting}>
            {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {isExporting ? 'Exporting...' : 'Export Route'}
          </Button>
        </div>

        <ExportRouteEmailDialog
          open={isEmailDialogOpen}
          onOpenChange={setIsEmailDialogOpen}
          storeIds={driverStoreIds}
          isExporting={isExporting}
          onExportRoute={handleDriverEmailExport} />
      </>
    );
  }

  // === ADMINS: Download PDF ===
  if (isAdmin) {
    const btnDisabled = !dateStr || !isRouteComplete || driverFilter === 'all' || dayDeliveries.length === 0;
    return (
      <div className="my-2 w-full flex justify-center">
        <Button
          onClick={() => handleExport('post-route')}
          className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
          disabled={btnDisabled || isExporting}>
          {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {isExporting ? 'Exporting...' : 'Export Route'}
        </Button>
      </div>
    );
  }

  // === DISPATCHERS ===
  if (isDispatcherOnly) {
    const noDriver = false;
    const noStoreDeliveries = dispatcherDayDeliveries.length === 0;
    const qualifiedPeriod = amQualified ? 'AM' : 'PM';
    const canPostRouteExport = isDispatcherRouteComplete && !noDriver && !noStoreDeliveries;
    const canPreRouteExport = qualifiedCount > 0 && !noDriver;


    return (
      <>
        <div className="w-full flex justify-center">
          <Button
            onClick={() => setIsEmailDialogOpen(true)}
            variant={isDispatcherRouteComplete ? 'default' : 'outline'}
            className={isDispatcherRouteComplete ? 'bg-emerald-600 hover:bg-emerald-700 text-white gap-2' : 'gap-2 text-white bg-slate-900 hover:bg-slate-800'}
            disabled={!canPostRouteExport && !canPreRouteExport || isExporting}>

            {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {isExporting ? 'Exporting...' : 'Export Route'}
          </Button>
        </div>

        <ExportRouteEmailDialog
          open={isEmailDialogOpen}
          onOpenChange={setIsEmailDialogOpen}
          storeIds={dispatcherStoreIds}
          isExporting={isExporting}
          onExportRoute={handleDispatcherEmailExport} />

      </>);

  }

  return null;
}