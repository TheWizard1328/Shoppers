import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import ExportRouteEmailDialog from "./ExportRouteEmailDialog";
import { format } from "date-fns";
import { userHasRole } from "../utils/userRoles";
import { globalFilters } from "@/components/utils/globalFilters";
import {
  buildManifestPayload,
  previewRouteManifest,
  emailRouteManifest,
  resolveDateRange,
  normalizeEmails,
} from "./routeManifestExportHelpers";

export default function ExportRouteButton({ currentUser, driverFilter, selectedDate, driverFilteredDeliveries, stores = [] }) {
  const finishedStatuses = ['completed', 'failed', 'cancelled'];
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
  const role = isAdmin ? 'admin' : isDispatcherOnly ? 'dispatcher' : isDriver ? 'driver' : null;
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

  // ─── Unified export flows — all roles funnel through the same generateRouteManifest ──

  // Dispatcher email export: single manifest across all their stores (all drivers).
  const handleDispatcherEmailExport = async ({ recipientEmails, exportDate: dialogExportDate, startDate, endDate, storeName: dialogStoreName, useBarcodes }) => {
    if (isExporting || !recipientEmails?.length) return;
    setIsExporting(true);
    try {
      const { startDate: effStart, endDate: effEnd } = resolveDateRange({ dialogStartDate: startDate || dialogExportDate, dialogEndDate: endDate, selectedDate });
      const firstStoreId = dispatcherStoreIds[0];
      const storeName = dialogStoreName || (stores || []).find((store) => store?.id === firstStoreId)?.name || 'Store';
      const validRecipientEmails = normalizeEmails(recipientEmails);
      if (validRecipientEmails.length === 0) { alert('Please add at least one valid email address.'); return; }

      const payload = buildManifestPayload({
        role: 'dispatcher',
        currentUser,
        dispatcherStoreIds,
        selectedCityId,
        startDate: effStart,
        endDate: effEnd,
        useBarcodes,
        recipientEmails: validRecipientEmails,
        storeName,
      });

      const data = await emailRouteManifest(payload);
      if (data?.error) { alert(data.error); return; }
      alert('Route log emailed successfully.');
    } catch (error) {
      alert(error?.response?.data?.error || error?.message || 'Route email export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  // Admin email export: one manifest per store (per-store recipient lists).
  const handleDriverEmailExport = async ({ perStoreEmails, exportDate: dialogExportDate, startDate, endDate, useBarcodes, stores: dialogStores }) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const { startDate: effStart, endDate: effEnd } = resolveDateRange({ dialogStartDate: startDate || dialogExportDate, dialogEndDate: endDate, selectedDate });

      const exportStoreIds = (dialogStores && dialogStores.length > 0)
        ? dialogStores.map((store) => store.id)
        : driverStoreIds;

      const emailJobs = [];
      exportStoreIds.forEach((storeId) => {
        const storeRecipientEmails = normalizeEmails(perStoreEmails?.[storeId] || []);
        if (storeRecipientEmails.length === 0) return;

        const storeName = (stores || []).find((store) => store?.id === storeId)?.name
          || dialogStores?.find((store) => store?.id === storeId)?.name
          || dayDeliveries.find((delivery) => delivery?.store_id === storeId)?.store_name
          || storeId;

        const payload = buildManifestPayload({
          role: 'admin',
          currentUser,
          selectedCityId,
          startDate: effStart,
          endDate: effEnd,
          useBarcodes,
          storeIdsOverride: [storeId],
          recipientEmails: storeRecipientEmails,
          storeName,
        });
        emailJobs.push(emailRouteManifest(payload));
      });

      if (emailJobs.length === 0) {
        alert('Please add at least one valid store email address.');
        return;
      }

      const results = await Promise.all(emailJobs);
      const failedResult = results.find((data) => data?.error);
      if (failedResult?.error) { alert(failedResult.error); return; }

      alert('Store route logs emailed successfully.');
    } catch (error) {
      alert(error?.response?.data?.error || error?.message || 'Route email export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  // Driver email export: single manifest across all stores for the logged-in driver.
  const handleMyRouteEmailExport = async ({ recipientEmails, exportDate: dialogExportDate, startDate, endDate, useBarcodes }) => {
    if (isExporting || !recipientEmails?.length) return;
    setIsExporting(true);
    try {
      const { startDate: effStart, endDate: effEnd } = resolveDateRange({ dialogStartDate: startDate || dialogExportDate, dialogEndDate: endDate, selectedDate });
      const validRecipientEmails = normalizeEmails(recipientEmails);
      if (validRecipientEmails.length === 0) { alert('Please add at least one valid email address.'); return; }

      const payload = buildManifestPayload({
        role: 'driver',
        currentUser,
        startDate: effStart,
        endDate: effEnd,
        useBarcodes,
        recipientEmails: validRecipientEmails,
        storeName: 'My Route',
      });

      const data = await emailRouteManifest(payload);
      if (data?.error) { alert(data.error); return; }
      alert('Route log emailed successfully.');
    } catch (error) {
      alert(error?.response?.data?.error || error?.message || 'Route email export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  // Direct download (button-only export used by legacy quick-export path).
  const handleExport = async (type, ampm) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      if (!role) return;
      // Driver previews self; dispatcher previews all store drivers; admin previews the selected driver.
      const driverId = isDriver ? currentUser.id : (isDispatcherOnly ? undefined : driverFilter);
      if (!driverId && !isDispatcherOnly) { alert('Select a driver first'); return; }
      const downloadDateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd');

      const payload = buildManifestPayload({
        role,
        currentUser,
        driverFilter,
        dispatcherStoreIds,
        selectedCityId,
        startDate: downloadDateStr,
        endDate: downloadDateStr,
        useBarcodes: false,
      });
      if (type === 'pre-route' && ampm) {
        payload.manifestType = 'pre-route';
        payload.ampm = ampm;
      }

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
      a.download = `RxDeliver Route Manifest ${downloadDateStr}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  // Unified preview: any role — opens PDF(s) in new tab.
  const handlePreviewPdf = async ({ startDate: dialogStartDate, endDate: dialogEndDate, useBarcodes } = {}) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const { startDate: effStart, endDate: effEnd } = resolveDateRange({ dialogStartDate, dialogEndDate, selectedDate });
      if (!role) return;

      const payload = buildManifestPayload({
        role,
        currentUser,
        driverFilter,
        dispatcherStoreIds,
        selectedCityId,
        driverStoreIds,
        startDate: effStart,
        endDate: effEnd,
        useBarcodes: useBarcodes === true,
      });

      const data = await previewRouteManifest(payload);
      if (data?.error) { alert(data.error); return; }
    } catch (error) {
      alert(error?.response?.data?.error || error?.message || 'Route preview failed.');
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

  // === DRIVERS === Export Route is admin/dispatcher only; drivers never see it.
  if (isDriver) {
    return null;
  }

  return null;
}