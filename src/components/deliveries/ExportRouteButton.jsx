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

  const handleDispatcherEmailExport = async ({ recipientEmails, exportDate: dialogExportDate }) => {
    if (isExporting || !recipientEmails?.length) return;
    setIsExporting(true);
    try {
      const exportConfig = isDispatcherRouteComplete ?
      { manifestType: 'post-route' } :
      qualifiedCount > 0 ?
      { manifestType: 'pre-route', ampm: amQualified ? 'AM' : 'PM' } :
      null;

      if (!exportConfig) return;

      const exportDate = dialogExportDate || (selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd'));
      const relevantDeliveries = exportConfig.manifestType === 'post-route' ?
      dispatcherDayDeliveries :
      dispatcherDayDeliveries.filter((d) => d && d.ampm_deliveries === exportConfig.ampm && !finishedStatuses.includes(d.status));
      const firstStoreId = relevantDeliveries.find((delivery) => delivery?.store_id)?.store_id || dispatcherStoreIds[0];
      const storeName = (stores || []).find((store) => store?.id === firstStoreId)?.name || 'Store';
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
        emailSubject: `RxDeliver Route logs for: ${storeName} - ${exportDate}`
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

  const handleDriverEmailExport = async ({ perStoreEmails, exportDate: dialogExportDate }) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const exportDate = dialogExportDate || (selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd'));
      const driverNames = getDriverNamesForSubject(dayDeliveries);
      const emailJobs = [];

      driverStoreIds.forEach((storeId) => {
        const storeRecipientEmails = [...new Set(((perStoreEmails?.[storeId]) || []).map((email) => typeof email === 'string' ? email.trim().toLowerCase() : '').filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
        if (storeRecipientEmails.length === 0) return;

        const storeName = (stores || []).find((store) => store?.id === storeId)?.name || dayDeliveries.find((delivery) => delivery?.store_id === storeId)?.store_name || storeId;

        emailJobs.push(
          base44.functions.invoke('generateRouteManifest', {
            driverId: driverFilter,
            deliveryDate: exportDate,
            manifestType: 'post-route',
            storeIds: [storeId],
            recipientEmails: storeRecipientEmails,
            emailSubject: `RxDeliver Route logs for: ${storeName} - ${exportDate}`
          })
        );
      });

      if (emailJobs.length === 0) {
        alert('Please add at least one valid store email address.');
        return;
      }

      const results = await Promise.all(emailJobs);
      const failedResult = results.map((res) => res?.data || res).find((data) => data?.error);
      if (failedResult?.error) {
        alert(failedResult.error);
        return;
      }

      alert('Store route logs emailed successfully.');
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
      if (data?.error) { alert(data.error); return; }

      const binaryStr = atob(data.pdfBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `RxDeliver Route Manifest ${dateStr}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  const handlePreviewPdf = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const exportAllDispatcherDrivers = isDispatcherOnly;
      const driverId = exportAllDispatcherDrivers ? undefined : driverFilter;
      if (!driverId && !exportAllDispatcherDrivers) {alert('Select a driver first');return;}
      const dateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd');

      let type = 'post-route';
      let ampm = undefined;
      if (isDispatcherOnly) {
        if (!isDispatcherRouteComplete && qualifiedCount > 0) {
          type = 'pre-route';
          ampm = amQualified ? 'AM' : 'PM';
        }
      } else {
        if (!isRouteComplete) {
          type = 'pre-route';
        }
      }

      const payload = {
        driverId,
        deliveryDate: dateStr,
        manifestType: type,
        ampm: type === 'pre-route' ? ampm : undefined,
        storeIds: isDispatcherOnly ? dispatcherStoreIds : undefined,
        selectedCityId: isDispatcherOnly ? selectedCityId : undefined
      };

      const res = await base44.functions.invoke('generateRouteManifest', payload);
      const data = res?.data || res;
      if (data?.error) { alert(data.error); return; }

      const binaryStr = atob(data.pdfBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } finally {
      setIsExporting(false);
    }
  };

  // === ADMINS ONLY ===
  if (isAdmin) {
    return (
      <>
        <div className="my-2 w-full flex justify-center">
          <Button
            onClick={() => setIsEmailDialogOpen(true)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
            disabled={isExporting}>
            {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {isExporting ? 'Exporting...' : 'Export Route'}
          </Button>
        </div>

        <ExportRouteEmailDialog
          open={isEmailDialogOpen}
          onOpenChange={setIsEmailDialogOpen}
          storeIds={driverStoreIds}
          isExporting={isExporting}
          onExportRoute={handleDriverEmailExport}
          onPreviewPdf={handlePreviewPdf} />
      </>
    );
  }

  // === DISPATCHERS ===
  if (isDispatcherOnly) {
    return (
      <>
        <div className="w-full flex justify-center">
          <Button
            onClick={() => setIsEmailDialogOpen(true)}
            variant="default"
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
            disabled={isExporting}>

            {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {isExporting ? 'Exporting...' : 'Export Route'}
          </Button>
        </div>

        <ExportRouteEmailDialog
          open={isEmailDialogOpen}
          onOpenChange={setIsEmailDialogOpen}
          storeIds={dispatcherStoreIds}
          isExporting={isExporting}
          onExportRoute={handleDispatcherEmailExport}
          onPreviewPdf={handlePreviewPdf} />

      </>);

  }

  return null;
}