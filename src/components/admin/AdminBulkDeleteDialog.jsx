import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';

export default function AdminBulkDeleteDialog({ bulkDelete, setBulkDelete }) {
  return (
    <Dialog
      open={bulkDelete.open}
      onOpenChange={(open) => {
        if (!bulkDelete.running) {
          setBulkDelete((prev) => ({ ...prev, open }));
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deleting {bulkDelete.entityLabel}</DialogTitle>
          <DialogDescription>
            {bulkDelete.running
              ? `Processing ${bulkDelete.processed} of ${bulkDelete.total}`
              : `Completed ${bulkDelete.success} successful, ${bulkDelete.failed} failed.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Progress value={bulkDelete.total ? bulkDelete.processed / bulkDelete.total * 100 : 0} />

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>Processed: {bulkDelete.processed}</div>
            <div>Success: {bulkDelete.success}</div>
            <div>Failed: {bulkDelete.failed}</div>
            <div>Retry Queue: {bulkDelete.retryQueue}</div>
          </div>

          {bulkDelete.currentLabel && (
            <div className="text-sm text-slate-600">Current: {bulkDelete.currentLabel}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}