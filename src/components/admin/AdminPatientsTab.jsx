import React, { useState } from 'react';
import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import PatientGPSUpdatesDialog from './PatientGPSUpdatesDialog';

export default function AdminPatientsTab({ dataViewMode, setDataViewMode, children }) {
  const [showPatientGpsUpdates, setShowPatientGpsUpdates] = useState(false);

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
      />
    </>
  );
}