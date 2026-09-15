import React, { useState } from 'react';
import { Loader2, MapPin, RefreshCw, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import PatientGPSUpdatesDialog from './PatientGPSUpdatesDialog';
import { useAppData } from '@/components/utils/AppDataContext';
import { useDevice } from '@/components/utils/DeviceContext';
import { Link } from 'react-router-dom';

export default function AdminPatientsTab({ dataViewMode, setDataViewMode, children, onBackfillLastDeliveryDates, isBackfilling: externalBackfillLoading = false, stores: storesProp }) {
  const { stores: contextStores } = useAppData();
  const { isMobile } = useDevice();
  const stores = storesProp || contextStores || [];
  const [showPatientGpsUpdates, setShowPatientGpsUpdates] = useState(false);
  const [localBackfillLoading, setLocalBackfillLoading] = useState(false);

  const isBackfilling = externalBackfillLoading || localBackfillLoading;

  const handleBackfillLastDeliveryDates = async () => {
    if (onBackfillLastDeliveryDates) {
      onBackfillLastDeliveryDates();
      return;
    }

    if (!window.confirm('Update patient last delivery dates using completed and failed deliveries from the last 90 days?')) {
      return;
    }

    setLocalBackfillLoading(true);
    try {
      const result = await base44.functions.invoke('syncPatientLastDeliveryDate', { backfillDays: 90 });
      window.dispatchEvent(new CustomEvent('forceDataRefresh'));
      alert(`Updated ${result?.data?.patientsUpdated ?? 0} patients from the last 90 days.`);
    } catch (error) {
      alert(`Failed to update last delivery dates: ${error.message}`);
    } finally {
      setLocalBackfillLoading(false);
    }
  };

  // Mobile-only layout (Sep 14 2026 fix): the whole tab becomes a flex column
  // capped at the height the page hands the "patients" TabsContent
  // (calc(100vh - 220px), set in AdminUtilities.jsx). This block of top
  // buttons stays a non-shrinking header; the children wrapper below flexes
  // to fill the remaining space so ONLY the table body scrolls — no more
  // double page-scroll pushing the table off the bottom of the screen with
  // dead white space beneath it. Desktop is untouched (original flex row).
  //
  // NOTE: flex-1 (flex-basis:0%) on a flex-wrap row lets 5 buttons squeeze
  // onto one line instead of wrapping (each item's hypothetical size is 0,
  // so the flexbox wrap algorithm never triggers a break) — that's what was
  // truncating the button labels on mobile. Grid with explicit columns fixes
  // it outright, independent of content width.
  const buttonRowClass = isMobile
    ? 'mb-4 grid grid-cols-2 gap-2 shrink-0'
    : 'mb-4 flex flex-wrap justify-end gap-2';
  const buttonClass = isMobile ? 'min-h-10 w-full' : 'min-h-10';

  const buttons = (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setShowPatientGpsUpdates(true)}
        className={buttonClass}
      >
        <MapPin className="mr-2 h-4 w-4" />
        GPS Updates
      </Button>
      <Button
        variant="outline"
        size="sm"
        asChild
        className={buttonClass}
      >
        <Link to="/PatientActivityReview">
          <Activity className="mr-2 h-4 w-4" />
          Activity Review
        </Link>
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={handleBackfillLastDeliveryDates}
        disabled={isBackfilling}
        className={buttonClass}
      >
        {isBackfilling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
        Backfill Last Delivery
      </Button>
      <div className={`flex gap-1 ${buttonClass}`}>
        <Button
          variant={dataViewMode.patients === 'offline' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDataViewMode((prev) => ({ ...prev, patients: 'offline' }))}
          className="flex-1 min-h-10 px-2"
        >
          Offline
        </Button>
        <Button
          variant={dataViewMode.patients !== 'offline' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDataViewMode((prev) => ({ ...prev, patients: 'online' }))}
          className="flex-1 min-h-10 px-2"
        >
          Online
        </Button>
      </div>
    </>
  );

  if (!isMobile) {
    return (
      <>
        <div className={buttonRowClass}>{buttons}</div>
        {children}
        <PatientGPSUpdatesDialog
          open={showPatientGpsUpdates}
          onOpenChange={setShowPatientGpsUpdates}
          stores={stores}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className={buttonRowClass}>{buttons}</div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {children}
      </div>

      <PatientGPSUpdatesDialog
        open={showPatientGpsUpdates}
        onOpenChange={setShowPatientGpsUpdates}
        stores={stores}
      />
    </div>
  );
}
