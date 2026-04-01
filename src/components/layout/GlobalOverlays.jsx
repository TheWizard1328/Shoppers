import React from 'react';
import ConflictManager from '../dashboard/ConflictManager';
import BulkDeleteJobMonitor from './BulkDeleteJobMonitor';

export default function GlobalOverlays() {
  return (
    <>
      <ConflictManager />
      <BulkDeleteJobMonitor />
    </>
  );
}