import React from 'react';
import { Button } from '@/components/ui/button';

export default function SimpleDataViewTab({ viewKey, dataViewMode, setDataViewMode, children }) {
  const isOffline = dataViewMode[viewKey] === 'offline';

  return (
    <>
      <div className="mb-4 flex justify-start md:justify-end gap-2">
        <Button
          variant={isOffline ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDataViewMode((prev) => ({ ...prev, [viewKey]: 'offline' }))}
          className="flex-1 md:flex-none min-h-10"
        >
          Offline
        </Button>
        <Button
          variant={!isOffline ? 'default' : 'outline'}
          size="sm"
          onClick={() => setDataViewMode((prev) => ({ ...prev, [viewKey]: 'online' }))}
          className="flex-1 md:flex-none min-h-10"
        >
          Online
        </Button>
      </div>
      {children}
    </>
  );
}