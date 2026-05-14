import React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertCircle, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function SkippedStopsDialog({ isOpen, skippedStops, onClose }) {
  if (!skippedStops || skippedStops.length === 0) return null;

  const getReasonLabel = (reason) => {
    switch (reason) {
      case 'geocoding_failed':
        return 'Address not found';
      case 'no_patient_address':
        return 'No patient address';
      case 'pickup_no_coords':
        return 'Store missing coordinates';
      default:
        return 'Missing coordinates';
    }
  };

  const getReasonColor = (reason) => {
    switch (reason) {
      case 'geocoding_failed':
        return 'bg-orange-100 text-orange-800';
      case 'no_patient_address':
        return 'bg-red-100 text-red-800';
      case 'pickup_no_coords':
        return 'bg-blue-100 text-blue-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-orange-600">
            <AlertCircle className="w-6 h-6" />
            Route Optimization Warning
          </AlertDialogTitle>
          <AlertDialogDescription className="pt-2">
            {skippedStops.length} stop{skippedStops.length !== 1 ? 's' : ''} could not be included in the optimized route due to missing or invalid location data.
            Please update the patient information or delete these deliveries.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex-1 overflow-y-auto my-4">
          <div className="space-y-3">
            {skippedStops.map((stop, index) => (
              <div
                key={stop.deliveryId}
                className="border rounded-lg p-4 bg-slate-50 hover:bg-slate-100 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <MapPin className="w-4 h-4 text-slate-400" />
                      <span className="font-semibold text-slate-900">
                        {stop.patientName || 'Unknown Patient'}
                      </span>
                    </div>
                    <p className="text-sm text-slate-600 mb-2">
                      {stop.address}
                    </p>
                    <div className="flex items-center gap-2">
                      <Badge className={getReasonColor(stop.reason)} variant="secondary">
                        {getReasonLabel(stop.reason)}
                      </Badge>
                      <span className="text-xs text-slate-500">
                        ID: {stop.deliveryId}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose} className="bg-orange-600 hover:bg-orange-700">
            Understand
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}