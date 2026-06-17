import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertCircle, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function SkippedStopsDialog({ isOpen, skippedStops, onClose }) {
  if (!skippedStops || skippedStops.length === 0) return null;

  const getReasonLabel = (reason) => {
    switch (reason) {
      case 'geocoding_failed':
        return 'Geocoding Failed';
      case 'no_patient_address':
        return 'No Address';
      case 'pickup_no_coords':
        return 'Missing Coordinates';
      default:
        return 'Missing Coordinates';
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600">
            <AlertCircle className="w-5 h-5" />
            Stops Skipped During Optimization
          </DialogTitle>
          <DialogDescription>
            {skippedStops.length} stop(s) could not be included in the route due to missing or invalid location data.
            Please update the patient information before optimizing the route.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-96 overflow-y-auto">
          {skippedStops.map((stop, index) => (
            <div
              key={stop.deliveryId || index}
              className="p-3 border border-red-200 bg-red-50 rounded-lg"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <MapPin className="w-4 h-4 text-red-600" />
                    <span className="font-semibold text-slate-900">
                      {stop.patientName || 'Unknown Patient'}
                    </span>
                  </div>
                  <p className="text-sm text-slate-600 mb-2">
                    {stop.address || 'No address available'}
                  </p>
                  <Badge variant="secondary" className="bg-red-100 text-red-700">
                    {getReasonLabel(stop.reason)}
                  </Badge>
                </div>
                <div className="text-xs text-slate-500">
                  Delivery ID: {stop.deliveryId}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button onClick={onClose} variant="outline">
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}