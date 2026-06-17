import React, { useState } from 'react';
import { Loader2, MapPin, RefreshCw, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { base44 } from '@/api/base44Client';
import PatientGPSUpdatesDialog from './PatientGPSUpdatesDialog';
import { useAppData } from '@/components/utils/AppDataContext';
import { Link } from 'react-router-dom';

export default function AdminPatientsTab({ dataViewMode, setDataViewMode, children, onBackfillLastDeliveryDates, isBackfilling: externalBackfillLoading = false, stores: storesProp }) {
  const { stores: contextStores } = useAppData();
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

  return (
    <>
      <div className="mb-4 flex flex-wrap justify-start gap-2 md:justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowPatientGpsUpdates(true)}
          className="min-h-10 flex-1 md:flex-none"
        >
          <MapPin className="mr-2 h-4 w-4" />
          GPS Updates
        </Button>
        <Button
          variant="outline"
          size="sm"
          asChild
          className="min-h-10 flex-1 md:flex-none"
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
          className="min-h-10 flex-1 md:flex-none"
        >
          {isBackfilling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Backfill Last Delivery
        </Button>
        <Button
          variant={dataViewMode.patients === 'offline' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDataViewMode((prev) => ({ ...prev, patients: 'offline' }))}
          className="min-h-10 flex-1 md:flex-none"
        >
          Offline
        </Button>
        <Button
          variant={dataViewMode.patients !== 'offline' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDataViewMode((prev) => ({ ...prev, patients: 'online' }))}
          className="min-h-10 flex-1 md:flex-none"
        >
          Online
        </Button>
      </div>

      {children}

      <PatientGPSUpdatesDialog
        open={showPatientGpsUpdates}
        onOpenChange={setShowPatientGpsUpdates}
        stores={stores}
      />
    </>
  );
}